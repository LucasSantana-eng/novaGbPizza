-- 1. Faça backup do banco e pause todos os caixas, garçons e serviços de impressão.
-- 2. Execute este arquivo inteiro no SQL Editor do Supabase.
-- 3. Publique index.html, garçon.html e menu-compartilhado.js juntos.
-- 4. Atualize index.js se o serviço de impressão legado estiver habilitado.
-- 5. Recarregue todos os dispositivos antes de retomar. Clientes antigos podem falhar ao salvar.
begin;

lock table public.app_state in access exclusive mode;

create table if not exists public.table_order_requests (
    request_id uuid primary key,
    employee_id text not null,
    request jsonb not null,
    order_data jsonb not null,
    created_at timestamptz not null default now()
);

alter table public.table_order_requests enable row level security;
revoke all on public.table_order_requests from public, anon, authenticated;

update public.app_state
set data = jsonb_set(data, '{_revision}', '0'::jsonb, true)
where id = 'gp_state' and not (data ? '_revision');

create or replace function public.guard_pos_state_revision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    old_revision bigint;
    new_revision bigint;
begin
    if old.id <> 'gp_state' then
        return new;
    end if;
    if jsonb_typeof(old.data -> '_revision') is distinct from 'number'
        or jsonb_typeof(new.data -> '_revision') is distinct from 'number' then
        raise exception 'Estado sem revisão. Atualize todos os dispositivos antes de salvar.'
            using errcode = '40001';
    end if;
    old_revision := (old.data ->> '_revision')::bigint;
    new_revision := (new.data ->> '_revision')::bigint;
    if old_revision <> new_revision then
        raise exception 'Estado alterado por outro dispositivo. Recarregue e confira a operação.'
            using errcode = '40001';
    end if;
    new.data := jsonb_set(new.data, '{_revision}', to_jsonb(old_revision + 1), true);
    new.updated_at := clock_timestamp();
    return new;
end;
$$;

drop trigger if exists gp_state_revision_guard on public.app_state;
create trigger gp_state_revision_guard
before update on public.app_state
for each row execute function public.guard_pos_state_revision();

create or replace function public.submit_table_order(
    p_request_id uuid,
    p_revision bigint,
    p_employee_id text,
    p_pin text,
    p_table integer,
    p_items jsonb,
    p_service boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    employee record;
    existing public.table_order_requests%rowtype;
    state jsonb;
    menu jsonb;
    item jsonb;
    request_data jsonb;
    order_data jsonb;
    order_id bigint;
    current_revision bigint;
    quantity numeric;
    price numeric;
    subtotal numeric := 0;
    service_rate numeric;
    service_amount numeric;
begin
    select id, name into employee from public.usuarios
    where id::text = p_employee_id and active = true and pin::text = p_pin;
    if not found then
        raise exception 'Funcionário ou PIN inválido.' using errcode = '28000';
    end if;
    if p_request_id is null or p_table is null or p_table not between 1 and 50
        or jsonb_typeof(p_items) is distinct from 'array' or p_service is null then
        raise exception 'Pedido de mesa inválido.' using errcode = '22023';
    end if;
    if jsonb_array_length(p_items) not between 1 and 100 then
        raise exception 'O pedido deve conter entre 1 e 100 itens.' using errcode = '22023';
    end if;
    request_data := jsonb_build_object('mesa', p_table, 'items', p_items, 'service', p_service);

    -- O bloqueio da linha também serializa pedidos com o mesmo identificador.
    select data into state from public.app_state where id = 'gp_state' for update;
    if not found then
        raise exception 'Estado do caixa não encontrado.' using errcode = 'P0002';
    end if;
    select * into existing from public.table_order_requests where request_id = p_request_id;
    if found then
        if existing.employee_id <> p_employee_id or existing.request <> request_data then
            raise exception 'Identificador de pedido já utilizado.' using errcode = '23505';
        end if;
        return existing.order_data;
    end if;
    if jsonb_typeof(state -> '_revision') is distinct from 'number' then
        raise exception 'A proteção de sincronização não está disponível.' using errcode = '40001';
    end if;
    current_revision := (state ->> '_revision')::bigint;
    if p_revision is distinct from current_revision then
        raise exception 'O caixa foi atualizado. Confira os itens e envie novamente.' using errcode = '40001';
    end if;
    if jsonb_typeof(state -> 'orders') is distinct from 'array'
        or jsonb_typeof(state -> 'menu') is distinct from 'object' then
        raise exception 'Estado do caixa ou cardápio inválido.' using errcode = '22023';
    end if;
    for item in select value from jsonb_array_elements(p_items) loop
        if jsonb_typeof(item) is distinct from 'object'
            or jsonb_typeof(item -> 'name') is distinct from 'string'
            or length(trim(item ->> 'name')) not between 1 and 200
            or jsonb_typeof(item -> 'category') is distinct from 'string'
            or jsonb_typeof(item -> 'qty') is distinct from 'number'
            or jsonb_typeof(item -> 'price') is distinct from 'number'
            or jsonb_typeof(item -> 'det') is distinct from 'array'
            or jsonb_typeof(item -> 'obs') is distinct from 'string' then
            raise exception 'Item de pedido inválido.' using errcode = '22023';
        end if;
        quantity := (item ->> 'qty')::numeric;
        price := (item ->> 'price')::numeric;
        if quantity <> trunc(quantity) or quantity not between 1 and 100
            or price <= 0 or price > 100000 or price <> round(price, 2)
            or length(item ->> 'obs') > 500 or jsonb_array_length(item -> 'det') > 30
            or exists (select 1 from jsonb_array_elements(item -> 'det') detail
                       where jsonb_typeof(detail) is distinct from 'string') then
            raise exception 'Quantidade, preço ou detalhes inválidos.' using errcode = '22023';
        end if;
        subtotal := subtotal + quantity * price;
    end loop;
    menu := state -> 'menu';
    service_rate := coalesce((menu ->> 'svc')::numeric, 10);
    if service_rate < 0 or service_rate > 100 then
        raise exception 'Taxa de serviço inválida no caixa.' using errcode = '22023';
    end if;
    service_amount := case when p_service then round(subtotal * service_rate / 100, 2) else 0 end;
    select greatest(
        coalesce((state ->> 'seq')::bigint, 1),
        coalesce(max((o ->> 'id')::bigint) filter (where o ->> 'id' ~ '^[0-9]{1,15}$'), 0) + 1
    ) into order_id from jsonb_array_elements(state -> 'orders') o;
    if order_id > 9007199254740990 then
        raise exception 'Número de pedido fora do limite permitido.' using errcode = '22023';
    end if;
    order_data := jsonb_build_object(
        'id', order_id, 'type', 'MESA', 'mesa', p_table, 'items', p_items,
        'taxa', 0, 'svc', service_amount, 'svcPct', service_rate,
        'sub', subtotal, 'total', subtotal + service_amount,
        'by', employee.name, 'byId', employee.id, 'status', 'PENDENTE', 'paid', false,
        'at', floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
        'printRequested', true, 'onlineOrderPrint', true, 'tableRequestId', p_request_id
    );
    state := jsonb_set(state, '{orders}', (state -> 'orders') || jsonb_build_array(order_data));
    state := jsonb_set(state, '{seq}', to_jsonb(order_id + 1), true);
    update public.app_state set data = state where id = 'gp_state';
    insert into public.table_order_requests (request_id, employee_id, request, order_data)
    values (p_request_id, p_employee_id, request_data, order_data);
    return order_data;
end;
$$;

revoke all on function public.submit_table_order(uuid, bigint, text, text, integer, jsonb, boolean) from public;
grant execute on function public.submit_table_order(uuid, bigint, text, text, integer, jsonb, boolean) to anon, authenticated;

commit;
