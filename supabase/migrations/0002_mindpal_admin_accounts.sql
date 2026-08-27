create table if not exists public.mindpal_admin_accounts (
    firebase_user_hash text primary key,
    firebase_email_hash text,
    is_admin boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint mindpal_admin_user_hash_format check (
        firebase_user_hash ~ '^usr_[0-9a-f]{32}$'
    ),
    constraint mindpal_admin_email_hash_format check (
        firebase_email_hash is null or firebase_email_hash ~ '^usr_[0-9a-f]{32}$'
    )
);

create unique index if not exists mindpal_admin_accounts_email_hash_idx
    on public.mindpal_admin_accounts (firebase_email_hash)
    where firebase_email_hash is not null;

alter table public.mindpal_admin_accounts enable row level security;

revoke all on public.mindpal_admin_accounts from anon, authenticated;
grant select, insert, update, delete on public.mindpal_admin_accounts to service_role;

create or replace function public.mindpal_set_admin_account(
    p_firebase_user_hash text,
    p_firebase_email_hash text,
    p_is_admin boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_firebase_user_hash !~ '^usr_[0-9a-f]{32}$' then
        raise exception 'invalid_firebase_user_hash';
    end if;

    if p_firebase_email_hash is not null
       and p_firebase_email_hash !~ '^usr_[0-9a-f]{32}$' then
        raise exception 'invalid_firebase_email_hash';
    end if;

    insert into public.mindpal_admin_accounts (
        firebase_user_hash,
        firebase_email_hash,
        is_admin,
        updated_at
    ) values (
        p_firebase_user_hash,
        p_firebase_email_hash,
        p_is_admin,
        now()
    )
    on conflict (firebase_user_hash) do update set
        firebase_email_hash = excluded.firebase_email_hash,
        is_admin = excluded.is_admin,
        updated_at = now();
end;
$$;

revoke all on function public.mindpal_set_admin_account(text, text, boolean)
    from public, anon, authenticated;
grant execute on function public.mindpal_set_admin_account(text, text, boolean)
    to service_role;
