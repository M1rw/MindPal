-- A rejected write must not leave a row behind.
--
-- 0004 inserted an empty '{}' placeholder before checking the expected
-- revision. When a writer holding a stale revision raced a delete, the check
-- failed but the placeholder stayed, so the deleted document came back as {}.
-- Creation now happens only when the caller expects the document to be absent.

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

    select revision into current_revision
    from public.mindpal_documents
    where collection = p_collection and doc_id = p_doc_id
    for update;

    if not found then
        if p_expected_revision > 0 then
            return jsonb_build_object('ok', false, 'revision', 0);
        end if;
        insert into public.mindpal_documents (collection, doc_id, data, revision)
        values (p_collection, p_doc_id, p_next_data, 1)
        on conflict (collection, doc_id) do nothing;
        if not found then
            return jsonb_build_object('ok', false, 'revision', null);
        end if;
        return jsonb_build_object('ok', true, 'revision', 1);
    end if;

    if current_revision <> p_expected_revision then
        return jsonb_build_object('ok', false, 'revision', current_revision);
    end if;

    update public.mindpal_documents
    set data = p_next_data,
        revision = current_revision + 1,
        updated_at = timezone('utc', now())
    where collection = p_collection and doc_id = p_doc_id;

    return jsonb_build_object('ok', true, 'revision', current_revision + 1);
end;
$$;

revoke all on function public.mindpal_update_document(text, text, bigint, jsonb)
    from public, anon, authenticated;
grant execute on function public.mindpal_update_document(text, text, bigint, jsonb)
    to service_role;

-- Per-user field lookups (data->>'user_id_hash') used by export, delete and retention.
create index if not exists mindpal_documents_user_idx
    on public.mindpal_documents (collection, (data->>'user_id_hash'));
