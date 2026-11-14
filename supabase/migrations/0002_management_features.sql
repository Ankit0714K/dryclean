-- Additive migration: order finance/dispatch fields and private admin-managed uploads.
alter table public.orders
  add column if not exists payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid','paid','partially_paid','refunded')),
  add column if not exists payment_method text
    check (payment_method is null or payment_method in ('cash','upi','card','online','other')),
  add column if not exists delivery_date date,
  add column if not exists delivery_slot_id uuid references public.pickup_slots(id);

create index if not exists orders_payment_status_idx on public.orders(payment_status);
create index if not exists customers_name_idx on public.customers using gin (to_tsvector('simple',full_name));

-- One database transaction creates/updates the customer and all booking records.
create or replace function public.create_booking(p_customer jsonb,p_order jsonb,p_items jsonb)
returns table(order_id uuid,order_code text)
language plpgsql security definer set search_path=public
as $$
declare
  v_customer_id uuid;
  v_order_id uuid;
  v_code text;
  v_expected int;
  v_found int;
begin
  if not coalesce((select pickup_enabled from public.business_settings where id=1),true) then
    raise exception 'Pickup booking is unavailable';
  end if;
  if not exists(select 1 from public.pickup_slots where id=(p_order->>'pickup_slot_id')::uuid and enabled) then
    raise exception 'Pickup time slot is unavailable';
  end if;
  select count(*) into v_expected from jsonb_array_elements(p_items);
  select count(*) into v_found from public.services s
    where s.enabled and s.id in (select (x->>'service_id')::uuid from jsonb_array_elements(p_items) x);
  if v_expected=0 or v_found<>v_expected then raise exception 'One or more services are unavailable'; end if;

  insert into public.customers(full_name,mobile,email)
    values(p_customer->>'full_name',p_customer->>'mobile',nullif(p_customer->>'email',''))
    on conflict(mobile) do update set full_name=excluded.full_name,email=excluded.email
    returning id into v_customer_id;
  v_code := 'FF-'||to_char(current_date,'YYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
  insert into public.orders(order_code,customer_id,address,locality,landmark,pincode,pickup_date,pickup_slot_id,estimated_quantity,special_instructions,additional_notes)
    values(v_code,v_customer_id,p_order->>'address',p_order->>'locality',nullif(p_order->>'landmark',''),p_order->>'pincode',(p_order->>'pickup_date')::date,(p_order->>'pickup_slot_id')::uuid,nullif(p_order->>'estimated_quantity',''),nullif(p_order->>'special_instructions',''),nullif(p_order->>'additional_notes',''))
    returning id into v_order_id;
  insert into public.order_items(order_id,service_id,service_name,quantity,unit_price)
    select v_order_id,s.id,s.name,greatest(1,coalesce((x->>'quantity')::numeric,1)),s.price
    from jsonb_array_elements(p_items) x join public.services s on s.id=(x->>'service_id')::uuid and s.enabled;
  insert into public.order_status_history(order_id,status,note) values(v_order_id,'pickup_requested','Booking received');
  return query select v_order_id,v_code;
end;
$$;
revoke all on function public.create_booking(jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.create_booking(jsonb,jsonb,jsonb) to service_role;

create or replace function public.admin_update_order(p_order_id uuid,p_changes jsonb,p_changed_by uuid)
returns public.orders language plpgsql security definer set search_path=public
as $$
declare
  v_before public.orders%rowtype;
  v_after public.orders%rowtype;
  v_item jsonb;
  v_total numeric(10,2):=0;
  v_status public.order_status;
begin
  select * into v_before from public.orders where id=p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if p_changes ? 'items' then
    for v_item in select value from jsonb_array_elements(p_changes->'items') loop
      update public.order_items set quantity=(v_item->>'quantity')::numeric,unit_price=(v_item->>'unit_price')::numeric
        where id=(v_item->>'id')::uuid and order_id=p_order_id;
      if not found then raise exception 'Order item not found'; end if;
      v_total:=v_total+((v_item->>'quantity')::numeric*(v_item->>'unit_price')::numeric);
    end loop;
    if jsonb_array_length(p_changes->'items')<>(select count(*) from public.order_items where order_id=p_order_id) then
      raise exception 'All order items must be included';
    end if;
  end if;
  v_status:=coalesce(nullif(p_changes->>'status','')::public.order_status,v_before.status);
  update public.orders set
    status=v_status,
    final_price=case when p_changes ? 'items' then coalesce(nullif(p_changes->>'final_price','')::numeric,v_total) when p_changes ? 'final_price' then nullif(p_changes->>'final_price','')::numeric else final_price end,
    internal_notes=case when p_changes ? 'internal_notes' then p_changes->>'internal_notes' else internal_notes end,
    pickup_assignment=case when p_changes ? 'pickup_assignment' then p_changes->>'pickup_assignment' else pickup_assignment end,
    delivery_assignment=case when p_changes ? 'delivery_assignment' then p_changes->>'delivery_assignment' else delivery_assignment end,
    delivery_date=case when p_changes ? 'delivery_date' then nullif(p_changes->>'delivery_date','')::date else delivery_date end,
    delivery_slot_id=case when p_changes ? 'delivery_slot_id' then nullif(p_changes->>'delivery_slot_id','')::uuid else delivery_slot_id end,
    payment_status=case when p_changes ? 'payment_status' then p_changes->>'payment_status' else payment_status end,
    payment_method=case when p_changes ? 'payment_method' then nullif(p_changes->>'payment_method','') else payment_method end,
    updated_at=now()
  where id=p_order_id returning * into v_after;
  if v_after.status is distinct from v_before.status then
    insert into public.order_status_history(order_id,status,note,changed_by)
      values(p_order_id,v_after.status,'Status updated by administrator',p_changed_by);
  end if;
  return v_after;
end;
$$;
revoke all on function public.admin_update_order(uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.admin_update_order(uuid,jsonb,uuid) to service_role;

create or replace function public.admin_dashboard_summary()
returns jsonb language sql stable security definer set search_path=public
as $$
  select jsonb_build_object(
    'totalOrders',(select count(*) from public.orders),
    'todayPickups',(select count(*) from public.orders where (created_at at time zone 'Asia/Kolkata')::date=(now() at time zone 'Asia/Kolkata')::date),
    'pending',(select count(*) from public.orders where status='pickup_requested'),
    'processing',(select count(*) from public.orders where status in ('clothes_picked_up','processing','ready_for_delivery','out_for_delivery')),
    'completed',(select count(*) from public.orders where status='delivered'),
    'customers',(select count(*) from public.customers),
    'revenue',(select coalesce(sum(final_price),0) from public.orders where status='delivered')
  );
$$;
revoke all on function public.admin_dashboard_summary() from public,anon,authenticated;
grant execute on function public.admin_dashboard_summary() to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values
  ('service-images','service-images',true,5242880,array['image/jpeg','image/png','image/webp']),
  ('business-assets','business-assets',true,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "admins upload business images" on storage.objects;
create policy "admins upload business images" on storage.objects for insert to authenticated
with check (bucket_id in ('service-images','business-assets') and public.is_admin());
drop policy if exists "admins update business images" on storage.objects;
create policy "admins update business images" on storage.objects for update to authenticated
using (bucket_id in ('service-images','business-assets') and public.is_admin())
with check (bucket_id in ('service-images','business-assets') and public.is_admin());
drop policy if exists "admins delete business images" on storage.objects;
create policy "admins delete business images" on storage.objects for delete to authenticated
using (bucket_id in ('service-images','business-assets') and public.is_admin());

-- Service photos are public assets, while writes are restricted to verified admins.
drop policy if exists "public read laundry images" on storage.objects;
create policy "public read laundry images" on storage.objects for select
using (bucket_id in ('service-images','business-assets'));
