import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '100kb' }));
const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024},fileFilter:(_req,file,cb)=>cb(null,['image/jpeg','image/png','image/webp'].includes(file.mimetype))});
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server/.env before starting the API.');
  process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{ persistSession:false,autoRefreshToken:false } });
const statusLabels = ['pickup_requested','pickup_confirmed','clothes_picked_up','processing','ready_for_delivery','out_for_delivery','delivered','cancelled'];
const indiaToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
const normalizeIndianMobile=value=>{const digits=String(value||'').replace(/\D/g,'');return digits.length===12&&digits.startsWith('91')?digits.slice(2):digits;};
const bookingSchema = z.object({
  fullName: z.string().trim().min(2).max(100), mobile: z.string().regex(/^(?:\+91|91)?[6-9]\d{9}$/),
  email: z.union([z.string().email().max(254), z.literal('')]).optional(), address: z.string().trim().min(8).max(500),
  locality: z.string().trim().min(2).max(100), landmark: z.string().max(150).optional(), pincode: z.string().regex(/^\d{6}$/),
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotId: z.string().uuid(), services: z.array(z.string().uuid()).min(1),
  quantity: z.string().max(80).optional(), instructions: z.string().max(1000).optional(), notes: z.string().max(1000).optional()
});
const fail = (res, error, status=400) => res.status(status).json({ error });
const publicLimiter=rateLimit({windowMs:15*60*1000,limit:30,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Too many requests. Please try again in a few minutes.'}});
const authLimiter=rateLimit({windowMs:15*60*1000,limit:8,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Too many sign-in attempts. Try again later.'}});

async function admin(req,res,next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i,'');
  if (!token) return fail(res,'Admin sign-in required',401);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return fail(res,'Invalid session',401);
  const { data } = await supabase.from('admins').select('user_id').eq('user_id',user.id).maybeSingle();
  if (!data) return fail(res,'Admin access required',403);
  req.user = user; next();
}

app.get('/api/health', (_req,res) => res.json({ ok:true }));
app.get('/api/public', async (_req,res) => {
  const [settings,services,slots] = await Promise.all([
    supabase.from('business_settings').select('*').eq('id',1).single(),
    supabase.from('services').select('id,name,description,price,pricing_unit,image_url').eq('enabled',true).order('sort_order'),
    supabase.from('pickup_slots').select('id,label').eq('enabled',true).order('sort_order')
  ]);
  if (settings.error || services.error || slots.error) return fail(res,'Unable to load shop information',500);
  res.json({ settings:settings.data, services:services.data, slots:slots.data });
});
app.post('/api/bookings', publicLimiter, async (req,res) => {
  const parsed = bookingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error:'Please check the booking details.', fields:parsed.error.flatten().fieldErrors });
  const b = parsed.data;
  if (b.pickupDate < indiaToday()) return fail(res,'Pickup date must be today or later.');
  const mobile = normalizeIndianMobile(b.mobile);
  const [slotResult,serviceResult,settingsResult] = await Promise.all([
    supabase.from('pickup_slots').select('id,label').eq('id',b.slotId).eq('enabled',true).maybeSingle(),
    supabase.from('services').select('id,name,price').in('id',b.services).eq('enabled',true),
    supabase.from('business_settings').select('pickup_enabled').eq('id',1).single()
  ]);
  if (settingsResult.data?.pickup_enabled === false) return fail(res,'Online pickup booking is temporarily unavailable.',409);
  if (!slotResult.data || serviceResult.data?.length !== b.services.length) return fail(res,'One or more selected options are unavailable.',409);
  const { data: created, error } = await supabase.rpc('create_booking',{
    p_customer:{full_name:b.fullName,mobile,email:b.email || ''},
    p_order:{address:b.address,locality:b.locality,landmark:b.landmark || '',pincode:b.pincode,pickup_date:b.pickupDate,pickup_slot_id:b.slotId,estimated_quantity:b.quantity || '',special_instructions:b.instructions || '',additional_notes:b.notes || ''},
    p_items:b.services.map(service_id=>({service_id,quantity:1}))
  });
  if (error) return fail(res,error.message?.includes('unavailable')?'A selected pickup slot or service is unavailable. Please refresh and try again.':'Could not create booking. Please try again or contact the shop.',409);
  const orderCode=created?.[0]?.order_code;
  res.status(201).json({ orderId:orderCode,status:'pickup_requested',message:'Pickup request received. The shop will confirm your slot.' });
});
app.post('/api/track', publicLimiter, async (req,res) => {
  const code = String(req.body?.orderId || '').trim().toUpperCase();
  const phone = normalizeIndianMobile(req.body?.mobile);
  if (!code || !/^[6-9]\d{9}$/.test(phone)) return fail(res,'Enter a valid order ID and Indian mobile number.');
  const { data: order } = await supabase.from('orders').select('order_code,status,pickup_date,created_at,updated_at,customers!inner(full_name,mobile),pickup_slots(label),order_items(service_name)').eq('order_code',code).eq('customers.mobile',phone).maybeSingle();
  if (!order) return fail(res,'No matching order found. Check the order ID and registered mobile number.',404);
  const { data: history } = await supabase.from('order_status_history').select('status,note,created_at').eq('order_id',(await supabase.from('orders').select('id').eq('order_code',code).single()).data.id).order('created_at',{ascending:false}).limit(10);
  res.json({ orderId:order.order_code,status:order.status,pickupDate:order.pickup_date,slot:order.pickup_slots?.label,items:order.order_items?.map(i=>i.service_name),history:history || [] });
});
app.post('/api/admin/login', authLimiter, async (req,res) => {
  const email=String(req.body?.email||''), password=String(req.body?.password||'');
  if (!email || !password) return fail(res,'Email and password are required.');
  const { data,error }=await authClient.auth.signInWithPassword({email,password});
  if (error) return fail(res,'Sign-in failed. Check your credentials.',401);
  const { data: adminRow }=await supabase.from('admins').select('user_id').eq('user_id',data.user.id).maybeSingle();
  if (!adminRow) return fail(res,'This account is not enabled as an administrator.',403);
  res.json({ accessToken:data.session.access_token,refreshToken:data.session.refresh_token,user:{email:data.user.email} });
});
app.post('/api/admin/refresh',authLimiter,async(req,res)=>{const refreshToken=String(req.body?.refreshToken||'');if(!refreshToken)return fail(res,'Admin sign-in required.',401);const {data,error}=await authClient.auth.refreshSession({refresh_token:refreshToken});if(error||!data.session)return fail(res,'Admin session expired. Sign in again.',401);const {data:adminRow}=await supabase.from('admins').select('user_id').eq('user_id',data.user.id).maybeSingle();if(!adminRow)return fail(res,'Admin access required.',403);res.json({accessToken:data.session.access_token,refreshToken:data.session.refresh_token,user:{email:data.user.email}});});
app.get('/api/admin/orders',admin,async (req,res)=>{
  let query=supabase.from('orders').select('*,customers!inner(full_name,mobile,email),pickup_slots(label),order_items(*)').order('created_at',{ascending:false});
  if(req.query.status) query=query.eq('status',req.query.status);
  if(req.query.from) query=query.gte('pickup_date',String(req.query.from));
  if(req.query.to) query=query.lte('pickup_date',String(req.query.to));
  if(req.query.search) { const s=String(req.query.search).replace(/[(),]/g,''); query=query.or(`order_code.ilike.%${s}%,full_name.ilike.%${s}%,mobile.ilike.%${s}%`,{foreignTable:'customers'}); }
  const {data,error}=await query.limit(250); if(error)return fail(res,'Unable to load orders.',500); res.json(data);
});
app.get('/api/admin/orders/:id',admin,async(req,res)=>{const {data,error}=await supabase.from('orders').select('*,customers(full_name,mobile,email),pickup_slots(label),order_items(*),order_status_history(status,note,created_at)').eq('id',req.params.id).order('created_at',{referencedTable:'order_status_history',ascending:false}).single();if(error)return fail(res,'Order not found.',404);res.json(data);});
app.get('/api/admin/summary',admin,async(_req,res)=>{
  const {data,error}=await supabase.rpc('admin_dashboard_summary');if(error)return fail(res,'Unable to load dashboard summary.',500);res.json(data);
});
app.get('/api/admin/customers',admin,async(_req,res)=>{const {data,error}=await supabase.from('customers').select('id,full_name,mobile,email,created_at,orders(id,order_code,status,created_at,final_price)').order('created_at',{ascending:false}).limit(500);if(error)return fail(res,'Unable to load customers.',500);res.json(data);});
app.get('/api/admin/settings',admin,async(_req,res)=>{const {data,error}=await supabase.from('business_settings').select('*').eq('id',1).single();if(error)return fail(res,'Unable to load business settings.',500);res.json(data);});
app.patch('/api/admin/settings',admin,async(req,res)=>{const schema=z.object({business_name:z.string().min(2).max(120).optional(),logo_url:z.string().url().nullable().optional(),shop_address:z.string().max(500).nullable().optional(),contact_number:z.string().max(30).nullable().optional(),whatsapp_number:z.string().max(30).nullable().optional(),opening_hours:z.string().max(200).nullable().optional(),pickup_enabled:z.boolean().optional(),service_areas:z.array(z.string().max(100)).max(100).optional(),social_links:z.record(z.string().url().or(z.literal(''))).optional()});const p=schema.safeParse(req.body);if(!p.success)return fail(res,'Invalid settings update.');const {data,error}=await supabase.from('business_settings').update({...p.data,updated_at:new Date().toISOString()}).eq('id',1).select().single();if(error)return fail(res,'Unable to save settings.',500);res.json(data);});
app.get('/api/admin/pickup-slots',admin,async(_req,res)=>{const {data,error}=await supabase.from('pickup_slots').select('*').order('sort_order');if(error)return fail(res,'Unable to load pickup slots.',500);res.json(data);});
app.post('/api/admin/pickup-slots',admin,async(req,res)=>{const p=z.object({label:z.string().min(3).max(80),enabled:z.boolean().default(true)}).safeParse(req.body);if(!p.success)return fail(res,'Enter a valid time-slot label.');const {data,error}=await supabase.from('pickup_slots').insert(p.data).select().single();if(error)return fail(res,'Unable to add pickup slot.',500);res.status(201).json(data);});
app.patch('/api/admin/pickup-slots/:id',admin,async(req,res)=>{const p=z.object({label:z.string().min(3).max(80).optional(),enabled:z.boolean().optional()}).safeParse(req.body);if(!p.success)return fail(res,'Invalid pickup slot.');const {data,error}=await supabase.from('pickup_slots').update(p.data).eq('id',req.params.id).select().single();if(error)return fail(res,'Unable to update pickup slot.',500);res.json(data);});
app.patch('/api/admin/orders/:id',admin,async(req,res)=>{
  const schema=z.object({status:z.enum(statusLabels).optional(),finalPrice:z.number().min(0).nullable().optional(),internalNotes:z.string().max(2000).optional(),pickupAssignment:z.string().max(200).optional(),deliveryAssignment:z.string().max(200).optional(),deliveryDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),deliverySlotId:z.string().uuid().nullable().optional(),paymentStatus:z.enum(['unpaid','paid','partially_paid','refunded']).optional(),paymentMethod:z.enum(['cash','upi','card','online','other']).nullable().optional(),items:z.array(z.object({id:z.string().uuid(),quantity:z.number().positive().max(10000),unit_price:z.number().min(0)})).optional()});
  const p=schema.safeParse(req.body); if(!p.success)return fail(res,'Invalid order update.');
  const fields=p.data;const changes={};
  if(fields.status)changes.status=fields.status;if(fields.finalPrice!==undefined)changes.final_price=fields.finalPrice;if(fields.internalNotes!==undefined)changes.internal_notes=fields.internalNotes;if(fields.pickupAssignment!==undefined)changes.pickup_assignment=fields.pickupAssignment;if(fields.deliveryAssignment!==undefined)changes.delivery_assignment=fields.deliveryAssignment;if(fields.deliveryDate!==undefined)changes.delivery_date=fields.deliveryDate;if(fields.deliverySlotId!==undefined)changes.delivery_slot_id=fields.deliverySlotId;if(fields.paymentStatus)changes.payment_status=fields.paymentStatus;if(fields.paymentMethod!==undefined)changes.payment_method=fields.paymentMethod;if(fields.items)changes.items=fields.items;
  const {data,error}=await supabase.rpc('admin_update_order',{p_order_id:req.params.id,p_changes:changes,p_changed_by:req.user.id});if(error)return fail(res,'Unable to update order. Check all item quantities, prices, and payment details.',400);res.json(data);
});
app.delete('/api/admin/orders/:id',admin,async(req,res)=>{const confirmation=String(req.body?.confirmation||'');const {data:order,error:lookupError}=await supabase.from('orders').select('id,order_code,status').eq('id',req.params.id).single();if(lookupError||!order)return fail(res,'Order not found.',404);if(order.status!=='cancelled'||confirmation!==order.order_code)return fail(res,'Only cancelled orders can be deleted, and the order ID must be confirmed.',409);const {error}=await supabase.from('orders').delete().eq('id',order.id);if(error)return fail(res,'Unable to delete order.',500);res.status(204).end();});
app.get('/api/admin/services',admin,async(_req,res)=>{const {data,error}=await supabase.from('services').select('*').order('sort_order');if(error)return fail(res,'Unable to load services.',500);res.json(data);});
app.post('/api/admin/services',admin,async(req,res)=>{const p=z.object({name:z.string().min(2).max(100),description:z.string().max(500).optional(),price:z.number().min(0).default(0),pricing_unit:z.string().max(40).default('per piece'),enabled:z.boolean().default(true),image_url:z.string().url().nullable().optional()}).safeParse(req.body);if(!p.success)return fail(res,'Invalid service details.');const {data,error}=await supabase.from('services').insert(p.data).select().single();if(error)return fail(res,'Unable to add service.',500);res.status(201).json(data);});
app.patch('/api/admin/services/:id',admin,async(req,res)=>{const p=z.object({name:z.string().min(2).max(100).optional(),description:z.string().max(500).optional(),price:z.number().min(0).optional(),pricing_unit:z.string().max(40).optional(),enabled:z.boolean().optional(),image_url:z.string().url().nullable().optional()}).safeParse(req.body);if(!p.success)return fail(res,'Invalid service update.');const {data,error}=await supabase.from('services').update(p.data).eq('id',req.params.id).select().single();if(error)return fail(res,'Unable to update service.',500);res.json(data);});
app.delete('/api/admin/services/:id',admin,async(req,res)=>{const {error}=await supabase.from('services').delete().eq('id',req.params.id);if(error)return fail(res,'Unable to delete service.',500);res.status(204).end();});
app.post('/api/admin/uploads',admin,upload.single('file'),async(req,res)=>{const bucket=String(req.query.bucket||'');if(!['service-images','business-assets'].includes(bucket))return fail(res,'Invalid image destination.');if(!req.file)return fail(res,'Choose a JPG, PNG, or WEBP image up to 5 MB.');const ext={ 'image/jpeg':'jpg','image/png':'png','image/webp':'webp' }[req.file.mimetype];const path=`${Date.now()}-${randomUUID()}.${ext}`;const {error}=await supabase.storage.from(bucket).upload(path,req.file.buffer,{contentType:req.file.mimetype,cacheControl:'3600',upsert:false});if(error)return fail(res,'Image upload failed.',500);const {data}=supabase.storage.from(bucket).getPublicUrl(path);res.status(201).json({url:data.publicUrl,path});});
const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
app.use('/api', (_req,res) => res.status(404).json({ error:'Not found.' }));
app.use(express.static(clientDist));
app.get('*', (_req,res) => res.sendFile(path.join(clientDist,'index.html')));
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:'Unexpected server error.'});});
const port=Number(process.env.PORT)||4000; app.listen(port,()=>console.log(`Laundry API listening on ${port}`));
