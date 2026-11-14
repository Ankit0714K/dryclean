# FreshFold Laundry booking platform

Responsive customer website and staff dashboard for laundry pickup bookings in SAS Nagar, Mohali. The app uses React/Vite/Tailwind in the browser, an Express API for validation and privileged operations, and Supabase for PostgreSQL and admin authentication.

## What is implemented

- Responsive homepage and full service catalogue with per-service images and admin-managed rates.
- Anonymous pickup booking with server validation and a database transaction that creates the customer, order, items and initial status history together.
- Order tracking with order ID plus registered mobile number; status history is returned without exposing database access to the browser.
- Supabase admin sign-in and dashboard with order/customer search, status/date filters, customer order history, order status history, inspected quantities and prices, payment state/method, staff assignments, delivery date, internal notes, and safe deletion of confirmed cancelled orders.
- Business settings, pickup availability, slot controls, logo uploads, and service image uploads. Uploads are limited to JPG/PNG/WEBP up to 5 MB and require verified admin access.
- Rate limits on public booking, tracking and sign-in; RLS policies and separate service-role and anon keys.
- Original site flows, WhatsApp link, location link and legal information pages are preserved.

The service prices are deliberately seeded at ₹0 (shown as “Price on inspection”) until the business sets rates. WhatsApp is hidden until a real number is configured.

## 1. Install

Install Node.js 20 or newer. In this project folder, run:

```sh
npm install
```

## 2. Create Supabase project and database

1. Create a Supabase project and keep the project URL, anon/public key, and service-role/secret key available.
2. Open **SQL Editor** in Supabase and run `supabase/migrations/0001_initial_schema.sql`, then `supabase/migrations/0002_management_features.sql` in that order.
3. In Supabase **Authentication → Users**, create the first staff user with email and a strong password.
4. Copy that user's UUID, then run this in SQL Editor (replace the UUID):

```sql
insert into public.admins(user_id) values ('00000000-0000-0000-0000-000000000000');
```

Only users with a row in `admins` can use the admin API. Keep the service-role key on the server; never add it to `client/.env` or commit either real `.env` file.

## 3. Configure local environment

Copy `client/.env.example` to `client/.env`. Its default local API address is ready to use. Copy `server/.env.example` to `server/.env`, then fill in the Supabase project URL, anon key, and service-role key. The service-role key bypasses RLS, so keep `server/.env` private.

Set `CLIENT_ORIGIN=http://localhost:5173` for local development. Configure business name, shop/contact/WhatsApp details by editing the single row in `business_settings` in Supabase. Example:

```sql
update public.business_settings
set business_name='Your Laundry Name', shop_address='Your address, SAS Nagar, Mohali',
    contact_number='YOUR_REAL_NUMBER', whatsapp_number='91YOURREALMOBILENUMBER'
where id=1;
```

Set actual service pricing in the admin dashboard after signing in.

## 4. Run locally

From the project root (standard npm workspace setup):

```sh
npm run dev
```

Open `http://localhost:5173`. The API listens at `http://localhost:4000`. Book a pickup with a real phone you control, then use the displayed order ID and same phone on **Track order**. Visit `/admin` and sign in with the Supabase user you added to `admins`.

If npm workspace linking is blocked by Windows permissions, install separately with `npm install --prefix client --workspaces=false` and `npm install --prefix server --workspaces=false`; install the root `concurrently` dev dependency with `npm install --workspaces=false` before using the root `npm run dev` script.

## 5. Deploy on Render

This repository includes a Render Blueprint that deploys the React site and Express API together at one HTTPS URL.

1. Create a Supabase project. Run `supabase/migrations/0001_initial_schema.sql` and then `0002_management_features.sql` in the Supabase SQL Editor.
2. Create the first staff user in Supabase Authentication and add its UUID to `public.admins` as described above.
3. In Render, create a new Blueprint from this repository's `main` branch and select the included `render.yaml`.
4. Enter the prompted server environment values: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Keep the service-role key in Render's server environment only.
5. After the deploy succeeds, open the Render URL, then configure the business contact details and service prices in the admin dashboard.

The site and API share the same origin; the API is available under `/api`. Never put the service-role key in a `VITE_*` variable or commit it to the repository.

## Verification and remaining launch checks

Verified in this workspace:

- `npm run build --prefix client` completes successfully.
- `node --check server/src/index.js` passes.
- The combined dev script starts both Vite and Express; the frontend returns HTTP 200 and `/api/health` returns `{ "ok": true }` using process-only test configuration.

Not yet verified: applying either SQL migration, Supabase Auth login/refresh, storage upload policies, database booking/price/status transactions, booking/tracking form round trips, and real mobile browser layouts. There is no `server/.env`, `client/.env`, PostgreSQL client, Supabase CLI, or Docker runtime available here. Those integration and viewport checks must be completed after configuring a real Supabase project; no fake booking or customer data was inserted. Before public launch, enter and confirm the real service rates, business contacts, service areas, opening hours and cancellation terms. The legal pages are starter copy and should be reviewed for the actual business. Online payment is not enabled.
