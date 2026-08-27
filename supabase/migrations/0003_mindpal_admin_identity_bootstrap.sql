alter table public.mindpal_admin_accounts drop constraint if exists mindpal_admin_accounts_pkey;
alter table public.mindpal_admin_accounts alter column firebase_user_hash drop not null;
alter table public.mindpal_admin_accounts add column if not exists id uuid default gen_random_uuid();
update public.mindpal_admin_accounts set id = gen_random_uuid() where id is null;
alter table public.mindpal_admin_accounts alter column id set not null;
alter table public.mindpal_admin_accounts add constraint mindpal_admin_accounts_pkey primary key (id);

create unique index if not exists mindpal_admin_accounts_user_hash_idx
    on public.mindpal_admin_accounts (firebase_user_hash)
    where firebase_user_hash is not null;

alter table public.mindpal_admin_accounts add constraint mindpal_admin_identity_present
    check (firebase_user_hash is not null or firebase_email_hash is not null);

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
    if p_firebase_user_hash is not null
       and p_firebase_user_hash !~ '^usr_[0-9a-f]{32}$' then
        raise exception 'invalid_firebase_user_hash';
    end if;

    if p_firebase_email_hash is not null
       and p_firebase_email_hash !~ '^usr_[0-9a-f]{32}$' then
        raise exception 'invalid_firebase_email_hash';
    end if;

    update public.mindpal_admin_accounts
    set firebase_user_hash = coalesce(p_firebase_user_hash, firebase_user_hash),
        firebase_email_hash = coalesce(p_firebase_email_hash, firebase_email_hash),
        is_admin = p_is_admin,
        updated_at = now()
    where (p_firebase_user_hash is not null and firebase_user_hash = p_firebase_user_hash)
       or (p_firebase_email_hash is not null and firebase_email_hash = p_firebase_email_hash);

    if not found then
        insert into public.mindpal_admin_accounts (
            firebase_user_hash,
            firebase_email_hash,
            is_admin,
            updated_at
        ) values (p_firebase_user_hash, p_firebase_email_hash, p_is_admin, now());
    end if;
end;
$$;

revoke all on function public.mindpal_set_admin_account(text, text, boolean)
    from public, anon, authenticated;
grant execute on function public.mindpal_set_admin_account(text, text, boolean)
    to service_role;
