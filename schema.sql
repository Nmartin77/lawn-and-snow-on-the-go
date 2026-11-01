-- Lawn and Snow on the Go: run this once in the Supabase SQL editor.
create table profiles(
  id uuid primary key references auth.users on delete cascade,
  role text not null check(role in('customer','company')),
  name text, phone text, company_name text, street text, city text, state text, zip text,
  stripe_customer_id text, stripe_account_id text, charges_enabled boolean not null default false,
  waiver_version int, waiver_signed_at timestamptz, waiver_name text,
  created_at timestamptz not null default now());
create table requests(
  id bigint generated always as identity primary key,
  customer_id uuid not null references profiles on delete cascade,
  service text not null, size_sqft int not null check(size_sqft>0), address text not null,
  lat double precision, lng double precision, preferred_date date, notes text,
  plan text not null default 'once' check(plan in('once','weekly','biweekly','monthly')),
  status text not null default 'open' check(status in('open','booked','done','cancelled')),
  booked_quote bigint, stripe_subscription_id text, created_at timestamptz not null default now());
create table quotes(
  id bigint generated always as identity primary key,
  request_id bigint not null references requests on delete cascade,
  company_id uuid not null references profiles on delete cascade,
  price_cents int not null check(price_cents>0), message text,
  created_at timestamptz not null default now(), unique(request_id,company_id));
create table crew_locations(
  company_id uuid primary key references profiles on delete cascade,
  lat double precision not null, lng double precision not null, updated_at timestamptz not null default now());

create function handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into profiles(id,role,name,company_name) values(new.id,coalesce(new.raw_user_meta_data->>'role','customer'),
    coalesce(new.raw_user_meta_data->>'name',new.raw_user_meta_data->>'full_name'),new.raw_user_meta_data->>'company_name');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

alter table profiles enable row level security;
alter table requests enable row level security;
alter table quotes enable row level security;
alter table crew_locations enable row level security;

-- Users can edit only safe profile fields. Stripe ids and payout status are written by the server only.
revoke insert,update,delete on profiles from authenticated;
grant update(name,phone,company_name,street,city,state,zip,waiver_version,waiver_signed_at,waiver_name) on profiles to authenticated;
revoke update on requests from authenticated;

create policy p_self on profiles for select using(id=auth.uid());
create policy p_self_upd on profiles for update using(id=auth.uid()) with check(id=auth.uid());
create policy p_companies on profiles for select using(role='company');
create policy p_booked_customer on profiles for select using(exists(
  select 1 from requests r join quotes q on q.id=r.booked_quote where r.customer_id=profiles.id and q.company_id=auth.uid()));

create policy r_customer on requests for all using(customer_id=auth.uid())
  with check(customer_id=auth.uid() and status='open' and booked_quote is null);
create policy r_company on requests for select using(
  exists(select 1 from profiles p where p.id=auth.uid() and p.role='company') and
  (status='open' or exists(select 1 from quotes q where q.id=booked_quote and q.company_id=auth.uid())));

create policy q_company on quotes for all using(company_id=auth.uid()) with check(company_id=auth.uid()
  and exists(select 1 from requests r where r.id=request_id and r.status='open'));
create policy q_customer on quotes for select using(exists(select 1 from requests r where r.id=request_id and r.customer_id=auth.uid()));

create policy l_company on crew_locations for all using(company_id=auth.uid()) with check(company_id=auth.uid());
create policy l_customer on crew_locations for select using(exists(
  select 1 from requests r join quotes q on q.id=r.booked_quote
  where r.customer_id=auth.uid() and r.status='booked' and q.company_id=crew_locations.company_id));

create function complete_request(rid bigint) returns void language sql security definer set search_path=public as $$
  update requests r set status='done' from quotes q
  where r.id=rid and r.status='booked' and r.plan='once' and q.id=r.booked_quote and q.company_id=auth.uid(); $$;

-- Lets a brand-new Google/Apple account pick its role. Only works before the account has signed the agreement or done anything.
create function claim_role(r text, company text) returns void language sql security definer set search_path=public as $$
  update profiles set role=r, company_name=coalesce(company,company_name)
  where id=auth.uid() and r in('customer','company') and waiver_version is null
  and not exists(select 1 from requests where customer_id=auth.uid())
  and not exists(select 1 from quotes where company_id=auth.uid()); $$;

alter publication supabase_realtime add table requests, quotes, crew_locations;
