create extension if not exists pgcrypto;

create type public.order_status as enum ('pickup_requested','pickup_confirmed','clothes_picked_up','processing','ready_for_delivery','out_for_delivery','delivered','cancelled');

create table public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.customers (
  id uuid primary key default gen_random_uuid(), full_name text not null, mobile text not null unique,
  email text, created_at timestamptz not null default now()
);
create table public.services (
  id uuid primary key default gen_random_uuid(), name text not null, description text not null default '',
  price numeric(10,2) not null default 0 check(price >= 0), pricing_unit text not null default 'per piece',
  image_url text, enabled boolean not null default true, sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create table public.pickup_slots (
  id uuid primary key default gen_random_uuid(), label text not null unique, enabled boolean not null default true,
  sort_order int not null default 0
);
create table public.orders (
  id uuid primary key default gen_random_uuid(), order_code text not null unique,
  customer_id uuid not null references public.customers(id), address text not null, locality text not null,
  landmark text, pincode text not null, pickup_date date not null, pickup_slot_id uuid references public.pickup_slots(id),
  estimated_quantity text, special_instructions text, additional_notes text,
  status public.order_status not null default 'pickup_requested', final_price numeric(10,2) check(final_price >= 0),
  internal_notes text, pickup_assignment text, delivery_assignment text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.order_items (
  id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete cascade,
  service_id uuid references public.services(id) on delete set null, service_name text not null,
  quantity numeric(10,2) not null default 1 check(quantity > 0), unit_price numeric(10,2) not null default 0 check(unit_price >= 0)
);
create table public.order_status_history (
  id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete cascade,
  status public.order_status not null, note text, changed_by uuid references auth.users(id), created_at timestamptz not null default now()
);
create table public.business_settings (
  id int primary key default 1 check(id = 1), business_name text not null default 'FreshFold Laundry',
  logo_url text, shop_address text default 'SAS Nagar, Mohali, Punjab', contact_number text, whatsapp_number text,
  opening_hours text default 'Mon–Sat, 9:00 AM–7:00 PM', pickup_enabled boolean not null default true,
  service_areas text[] not null default '{}', social_links jsonb not null default '{}', updated_at timestamptz not null default now()
);

create index orders_status_created_idx on public.orders(status, created_at desc);
create index orders_pickup_date_idx on public.orders(pickup_date);
create index order_history_order_created_idx on public.order_status_history(order_id, created_at desc);

insert into public.business_settings(id) values (1) on conflict do nothing;
insert into public.pickup_slots(label,sort_order) values ('9:00 AM – 12:00 PM',1),('12:00 PM – 3:00 PM',2),('3:00 PM – 6:00 PM',3) on conflict do nothing;
insert into public.services(name,description,price,pricing_unit,sort_order) values
('Washing','Everyday laundry, washed with care.',0,'per kg',1),
('Washing and Ironing','A fresh wash and a crisp finish.',0,'per kg',2),
('Steam Ironing','Gentle steam finish for a polished look.',0,'per piece',3),
('Normal Ironing','Neat, everyday pressing.',0,'per piece',4),
('Saree Ironing','Careful handling for sarees and delicate drapes.',0,'per piece',5),
('Shirt Ironing','Sharp collars and smooth seams.',0,'per piece',6),
('Pant / Trouser Ironing','A clean crease, ready to wear.',0,'per piece',7),
('Suit Dry Cleaning','Professional care for formal suits.',0,'per set',8),
('Blazer Dry Cleaning','Specialist care for structured garments.',0,'per piece',9),
('Coat Cleaning','Thorough care for coats and outerwear.',0,'per piece',10),
('Bedsheet Cleaning','Fresh, clean bedding.',0,'per piece',11),
('Blanket Cleaning','Deep clean for bulky blankets.',0,'per piece',12),
('Curtains Cleaning','Refresh curtains and soft furnishings.',0,'per panel',13),
('Premium Garment Care','Extra attention for delicate and premium fabrics.',0,'per piece',14),
('Other Garment Services','Tell us what needs special care.',0,'as quoted',15);

alter table public.admins enable row level security;
alter table public.customers enable row level security;
alter table public.services enable row level security;
alter table public.pickup_slots enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_status_history enable row level security;
alter table public.business_settings enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.admins where user_id = auth.uid()) $$;

create policy "public read enabled services" on public.services for select using (enabled);
create policy "public read enabled slots" on public.pickup_slots for select using (enabled);
create policy "public read business settings" on public.business_settings for select using (true);
create policy "admins manage admins" on public.admins for all using (public.is_admin()) with check (public.is_admin());
create policy "admins manage customers" on public.customers for all using (public.is_admin()) with check (public.is_admin());
create policy "admins manage services" on public.services for all using (public.is_admin()) with check (public.is_admin());
create policy "admins manage slots" on public.pickup_slots for all using (public.is_admin()) with check (public.is_admin());
create policy "admins manage business settings" on public.business_settings for all using (public.is_admin()) with check (public.is_admin());
create policy "admins manage orders" on public.orders for all using (public.is_admin()) with check (public.is_admin());
create policy "admins manage order items" on public.order_items for all using (public.is_admin()) with check (public.is_admin());
create policy "admins manage order history" on public.order_status_history for all using (public.is_admin()) with check (public.is_admin());
