create table if not exists public.mindpal_documents (
    collection text not null,
    doc_id text not null,
    data jsonb not null default '{}'::jsonb,
    revision bigint not null default 1 check (revision > 0),
    updated_at timestamptz not null default timezone('utc', now()),
    primary key (collection, doc_id),
    constraint mindpal_documents_collection_length check (char_length(collection) between 1 and 80),
    constraint mindpal_documents_doc_id_length check (char_length(doc_id) between 1 and 256)
);

alter table public.mindpal_documents enable row level security;
revoke all on table public.mindpal_documents from anon, authenticated;
grant select, insert, update, delete on public.mindpal_documents to service_role;

create index if not exists mindpal_documents_collection_doc_id_idx
    on public.mindpal_documents (collection, doc_id);

create or replace function public.mindpal_update_document(
    p_collection text,
    p_doc_id text,
    p_expected_revision bigint,
    p_next_data jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    current_revision bigint;
begin
    if p_collection is null or char_length(p_collection) not between 1 and 80
       or p_doc_id is null or char_length(p_doc_id) not between 1 and 256
       or p_expected_revision < 0
       or p_next_data is null or jsonb_typeof(p_next_data) <> 'object' then
        raise exception 'invalid_document_payload';
    end if;

    insert into public.mindpal_documents (collection, doc_id, data, revision)
    values (p_collection, p_doc_id, '{}'::jsonb, 1)
    on conflict (collection, doc_id) do nothing;

    select revision into current_revision
    from public.mindpal_documents
    where collection = p_collection and doc_id = p_doc_id
    for update;

    if current_revision <> greatest(p_expected_revision, 1) then
        return jsonb_build_object('ok', false, 'revision', current_revision);
    end if;

    update public.mindpal_documents
    set data = p_next_data,
        revision = current_revision + 1,
        updated_at = timezone('utc', now())
    where collection = p_collection and doc_id = p_doc_id;

    return jsonb_build_object(
        'ok', true,
        'revision', current_revision + 1,
        'data', p_next_data
    );
end;
$$;

revoke all on function public.mindpal_update_document(text, text, bigint, jsonb)
    from public, anon, authenticated;
grant execute on function public.mindpal_update_document(text, text, bigint, jsonb)
    to service_role;
