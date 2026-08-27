create table if not exists public.mindpal_feature_policies (
    key text primary key check (key = 'current'),
    revision bigint not null default 0 check (revision >= 0),
    policies jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default timezone('utc', now())
);

alter table public.mindpal_feature_policies enable row level security;
revoke all on table public.mindpal_feature_policies from anon, authenticated;

create or replace function public.mindpal_update_feature_policies(
    expected_revision bigint,
    next_policies jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    current_revision bigint;
begin
    if expected_revision < 0 or next_policies is null or jsonb_typeof(next_policies) <> 'object' then
        raise exception 'invalid_feature_policy_payload';
    end if;

    insert into public.mindpal_feature_policies (key, revision, policies)
    values ('current', 0, '{}'::jsonb)
    on conflict (key) do nothing;

    select revision into current_revision
    from public.mindpal_feature_policies
    where key = 'current'
    for update;

    if current_revision <> expected_revision then
        return jsonb_build_object(
            'ok', false,
            'revision', current_revision,
            'policies', (select policies from public.mindpal_feature_policies where key = 'current')
        );
    end if;

    update public.mindpal_feature_policies
    set revision = current_revision + 1,
        policies = next_policies,
        updated_at = timezone('utc', now())
    where key = 'current';

    return jsonb_build_object(
        'ok', true,
        'revision', current_revision + 1,
        'policies', next_policies
    );
end;
$$;

revoke all on function public.mindpal_update_feature_policies(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.mindpal_update_feature_policies(bigint, jsonb) to service_role;
