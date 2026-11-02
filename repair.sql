-- Lawn and Snow on the Go: REPAIR / UPDATE SCRIPT. Safe to run more than once. It sets up anything missing,
-- fixes the access rules, creates profiles for existing accounts, and grants the site permission to its tables.
create table if not exists profiles(
  id uuid primary key references auth.users on delete cascade,
  role text not null check(role in('customer','company')),
  name text, phone text, company_name text, street text, city text, state text, zip text,
  stripe_customer_id text, stripe_account_id text, charges_enabled boolean not null default false,
  waiver_version int, waiver_signed_at timestamptz, waiver_name text,
  created_at timestamptz not null default now());
create table if not exists requests(
  id bigint generated always as identity primary key,
  customer_id uuid not null references profiles on delete cascade,
  service text not null, size_sqft int not null check(size_sqft>0), address text not null,
  lat double precision, lng double precision, preferred_date date, notes text,
  plan text not null default 'once' check(plan in('once','weekly','biweekly','monthly')),
  status text not null default 'open' check(status in('open','booked','done','cancelled')),
  booked_quote bigint, stripe_subscription_id text, created_at timestamptz not null default now());
create table if not exists quotes(
  id bigint generated always as identity primary key,
  request_id bigint not null references requests on delete cascade,
  company_id uuid not null references profiles on delete cascade,
  price_cents int not null check(price_cents>0), message text,
  created_at timestamptz not null default now(), unique(request_id,company_id));
create table if not exists crew_locations(
  company_id uuid primary key references profiles on delete cascade,
  lat double precision not null, lng double precision not null, updated_at timestamptz not null default now());

create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into profiles(id,role,name,company_name) values(new.id,coalesce(new.raw_user_meta_data->>'role','customer'),
    coalesce(new.raw_user_meta_data->>'name',new.raw_user_meta_data->>'full_name'),new.raw_user_meta_data->>'company_name');
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

alter table profiles enable row level security;
alter table requests enable row level security;
alter table quotes enable row level security;
alter table crew_locations enable row level security;

-- Users can edit only safe profile fields. Stripe ids and payout status are written by the server only.
revoke insert,update,delete on profiles from authenticated;
grant update(name,phone,company_name,street,city,state,zip,waiver_version,waiver_signed_at,waiver_name) on profiles to authenticated;
revoke update on requests from authenticated;

-- Helper functions read other tables without triggering their policies. Without them, the policies
-- would refer to each other in a loop and Postgres would fail with "infinite recursion".
create or replace function is_company() returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from profiles where id=auth.uid() and role='company') $$;
create or replace function quote_company(qid bigint) returns uuid language sql stable security definer set search_path=public as $$
  select company_id from quotes where id=qid $$;
create or replace function request_customer(rid bigint) returns uuid language sql stable security definer set search_path=public as $$
  select customer_id from requests where id=rid $$;
create or replace function request_status(rid bigint) returns text language sql stable security definer set search_path=public as $$
  select status from requests where id=rid $$;
create or replace function booked_crew_for(cust uuid) returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from requests r join quotes q on q.id=r.booked_quote where r.customer_id=cust and q.company_id=auth.uid()) $$;

-- Where each crew works: a base point and a radius of up to 10 miles. Only the crew can read its own row.
create table if not exists crew_areas(
  company_id uuid primary key references profiles on delete cascade,
  lat double precision not null, lng double precision not null,
  radius_miles int not null default 10 check(radius_miles between 1 and 10),
  label text, updated_at timestamptz not null default now());
alter table crew_areas enable row level security;
grant select,insert,update,delete on crew_areas to authenticated;

create or replace function miles_between(a1 double precision, o1 double precision, a2 double precision, o2 double precision) returns double precision
language sql immutable as $$
  select 3958.8 * 2 * asin(least(1, sqrt(power(sin(radians(a2-a1)/2),2) + cos(radians(a1))*cos(radians(a2))*power(sin(radians(o2-o1)/2),2)))) $$;
create or replace function crew_in_range(rlat double precision, rlng double precision) returns boolean language sql stable security definer set search_path=public as $$
  select rlat is not null and exists(select 1 from crew_areas a where a.company_id=auth.uid() and miles_between(a.lat,a.lng,rlat,rlng) <= least(a.radius_miles,10)) $$;
create or replace function crew_can_quote(rid bigint) returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from requests r join crew_areas a on a.company_id=auth.uid()
    where r.id=rid and r.status='open' and r.lat is not null and miles_between(a.lat,a.lng,r.lat,r.lng) <= least(a.radius_miles,10)) $$;
-- Crews within 10 miles of a point (shown to customers). Returns only names and rounded distance, never a crew's exact location.
create or replace function nearby_crews(rlat double precision, rlng double precision) returns table(company_id uuid, company_name text, miles numeric)
language sql stable security definer set search_path=public as $$
  select p.id, p.company_name, round(miles_between(a.lat,a.lng,rlat,rlng)::numeric,1)
  from crew_areas a join profiles p on p.id=a.company_id
  where p.role='company' and miles_between(a.lat,a.lng,rlat,rlng) <= least(a.radius_miles,10) order by 3 $$;
revoke execute on function nearby_crews(double precision, double precision) from public, anon;
grant execute on function nearby_crews(double precision, double precision) to authenticated;

drop policy if exists p_self on profiles;
create policy p_self on profiles for select using(id=auth.uid());
drop policy if exists p_self_upd on profiles;
create policy p_self_upd on profiles for update using(id=auth.uid()) with check(id=auth.uid());
drop policy if exists p_companies on profiles;
create policy p_companies on profiles for select using(role='company');
drop policy if exists p_booked_customer on profiles;
create policy p_booked_customer on profiles for select using(booked_crew_for(profiles.id));

drop policy if exists r_customer on requests;
create policy r_customer on requests for all using(customer_id=auth.uid())
  with check(customer_id=auth.uid() and status='open' and booked_quote is null);
drop policy if exists r_company on requests;
create policy r_company on requests for select using(is_company() and ((status='open' and crew_in_range(lat,lng)) or quote_company(booked_quote)=auth.uid()));
drop policy if exists ca_own on crew_areas;
create policy ca_own on crew_areas for all using(company_id=auth.uid()) with check(company_id=auth.uid() and is_company());

drop policy if exists q_company on quotes;
create policy q_company on quotes for all using(company_id=auth.uid()) with check(company_id=auth.uid() and is_company() and crew_can_quote(request_id));
drop policy if exists q_customer on quotes;
create policy q_customer on quotes for select using(request_customer(request_id)=auth.uid());

drop policy if exists l_company on crew_locations;
create policy l_company on crew_locations for all using(company_id=auth.uid()) with check(company_id=auth.uid());
drop policy if exists l_customer on crew_locations;
create policy l_customer on crew_locations for select using(exists(
  select 1 from requests r join quotes q on q.id=r.booked_quote
  where r.customer_id=auth.uid() and r.status='booked' and q.company_id=crew_locations.company_id));

-- Lets a brand-new Google/Apple account pick its role. Only works before the account has signed the agreement or done anything.
create or replace function claim_role(r text, company text) returns void language sql security definer set search_path=public as $$
  update profiles set role=r, company_name=coalesce(company,company_name)
  where id=auth.uid() and r in('customer','company') and waiver_version is null
  and not exists(select 1 from requests where customer_id=auth.uid())
  and not exists(select 1 from quotes where company_id=auth.uid()); $$;

-- Payments are held until the crew finishes the job and uploads photos. Only the server writes these tables.
create table if not exists payments(
  id bigint generated always as identity primary key,
  request_id bigint not null references requests on delete cascade,
  quote_id bigint not null,
  customer_id uuid not null references profiles,
  company_id uuid not null references profiles,
  amount_cents int not null, service_fee_cents int not null default 0, fee_cents int not null, crew_cents int not null,
  stripe_charge_id text not null unique,
  status text not null default 'held' check(status in('held','review','disputed','releasing','released','refunded')),
  review_ends_at timestamptz,
  eta_at timestamptz, arrived_at timestamptz, window_ends_at timestamptz,
  created_at timestamptz not null default now(), released_at timestamptz);
create table if not exists completions(
  id bigint generated always as identity primary key,
  payment_id bigint not null unique references payments on delete cascade,
  request_id bigint not null references requests on delete cascade,
  company_id uuid not null references profiles,
  notes text, photos text[] not null check(array_length(photos,1)>=1),
  created_at timestamptz not null default now());
alter table payments enable row level security;
alter table completions enable row level security;
revoke insert,update,delete on payments, completions from authenticated;
drop policy if exists pay_parties on payments;
create policy pay_parties on payments for select using(customer_id=auth.uid() or company_id=auth.uid());
drop policy if exists comp_parties on completions;
create policy comp_parties on completions for select using(company_id=auth.uid() or request_customer(request_id)=auth.uid());

create table if not exists disputes(
  id bigint generated always as identity primary key,
  payment_id bigint not null references payments on delete cascade,
  request_id bigint not null references requests on delete cascade,
  customer_id uuid not null references profiles,
  company_id uuid not null references profiles,
  kind text not null check(kind in('refund','dispute')),
  reason text not null,
  status text not null default 'open' check(status in('open','refunded','released')),
  resolution_note text,
  created_at timestamptz not null default now(), resolved_at timestamptz);
alter table disputes enable row level security;
revoke insert,update,delete on disputes from authenticated;
drop policy if exists disp_parties on disputes;
create policy disp_parties on disputes for select using(customer_id=auth.uid() or company_id=auth.uid());

-- Private storage for job photos. Folder names are crew-id/payment-id/file.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('job-photos','job-photos',false,5242880,array['image/jpeg','image/png','image/webp']) on conflict(id) do nothing;
drop policy if exists job_photos_upload on storage.objects;
create policy job_photos_upload on storage.objects for insert to authenticated
  with check(bucket_id='job-photos' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists job_photos_read on storage.objects;
create policy job_photos_read on storage.objects for select to authenticated
  using(bucket_id='job-photos' and ((storage.foldername(name))[1]=auth.uid()::text
    or exists(select 1 from public.payments p where p.id::text=(storage.foldername(name))[2] and p.customer_id=auth.uid())));

-- Photos on requests (from the customer) and on quotes (from the crew). Files live in the private "quote-photos" bucket.
alter table requests add column if not exists photos text[] not null default '{}' check(coalesce(array_length(photos,1),0)<=6);
alter table quotes add column if not exists photos text[] not null default '{}' check(coalesce(array_length(photos,1),0)<=6);
create or replace function check_photo_paths() returns trigger language plpgsql as $$
declare p text; owner uuid;
begin
  if TG_TABLE_NAME = 'requests' then owner := new.customer_id; else owner := new.company_id; end if;
  foreach p in array new.photos loop
    if split_part(p,'/',1) <> owner::text then raise exception 'A photo path does not belong to you.'; end if;
  end loop;
  return new;
end $$;
drop trigger if exists requests_photos on requests;
create trigger requests_photos before insert or update on requests for each row execute function check_photo_paths();
drop trigger if exists quotes_photos on quotes;
create trigger quotes_photos before insert or update on quotes for each row execute function check_photo_paths();
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('quote-photos','quote-photos',false,5242880,array['image/jpeg','image/png','image/webp']) on conflict(id) do nothing;
drop policy if exists quote_photos_upload on storage.objects;
create policy quote_photos_upload on storage.objects for insert to authenticated
  with check(bucket_id='quote-photos' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists quote_photos_read on storage.objects;
create policy quote_photos_read on storage.objects for select to authenticated
  using(bucket_id='quote-photos' and ((storage.foldername(name))[1]=auth.uid()::text
    or exists(select 1 from public.requests r where name = any(r.photos))
    or exists(select 1 from public.quotes q where name = any(q.photos))));

do $$ declare t text; begin
  foreach t in array array['requests','quotes','crew_locations','payments','completions','disputes'] loop
    begin execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;

-- Customers may add photos to their own open requests (only the photos column can change).
grant update(photos) on public.requests to authenticated;

alter table public.payments add column if not exists review_ends_at timestamptz;
alter table public.payments add column if not exists service_fee_cents int not null default 0;
alter table public.payments add column if not exists eta_at timestamptz;
alter table public.payments add column if not exists arrived_at timestamptz;
alter table public.payments add column if not exists window_ends_at timestamptz;
alter table public.payments drop constraint if exists payments_status_check;
alter table public.payments add constraint payments_status_check check(status in('held','review','disputed','releasing','released','refunded'));
drop function if exists public.complete_request(bigint);

insert into public.profiles (id, role, name, company_name)
select u.id, coalesce(u.raw_user_meta_data->>'role','customer'),
       coalesce(u.raw_user_meta_data->>'name', u.raw_user_meta_data->>'full_name', split_part(u.email,'@',1)),
       u.raw_user_meta_data->>'company_name'
from auth.users u where u.id not in (select id from public.profiles);

grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.requests, public.quotes, public.crew_locations, public.payments, public.completions, public.disputes to authenticated;
grant insert, delete on public.requests to authenticated;
grant insert, update, delete on public.quotes to authenticated;
grant insert, update, delete on public.crew_locations to authenticated;
grant select, insert, update, delete on public.crew_areas to authenticated;
grant update(photos) on public.requests to authenticated;
grant execute on function public.claim_role(text, text) to authenticated;
