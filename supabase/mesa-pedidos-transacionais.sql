-- 1. Faça backup do banco e pause todos os caixas, garçons e serviços de impressão.
-- 2. Confira as mesas abertas: o script unifica seus pedidos e recalcula a taxa
--    configurada no cardápio sobre o subtotal da comanda. Pedidos originais são
--    preservados em tableOriginalOrders; contas pagas e canceladas não são alteradas.
--    Se uma mesa possuir serviço em algum pedido, a taxa incidirá sobre toda a mesa.
-- 3. Execute este arquivo inteiro no SQL Editor do Supabase.
-- 4. Publique index.html, garçon.html, menu-compartilhado.js e
--    mesa-conta-compartilhada.js juntos. Atualize index.js se o serviço legado estiver habilitado.
-- 5. Recarregue todos os dispositivos, confira as comandas abertas e retome.
--    Clientes antigos não são compatíveis com o novo formato de lançamentos.
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

create or replace function public.consolidate_open_table_orders(p_state jsonb, p_table integer, p_rate numeric)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
    entry jsonb;
    item jsonb;
    primary_order jsonb;
    batches jsonb := '[]'::jsonb;
    items jsonb := '[]'::jsonb;
    originals jsonb := '[]'::jsonb;
    result_orders jsonb := '[]'::jsonb;
    batch_id text;
    enabled boolean := false;
    subtotal numeric := 0;
    fees numeric := 0;
    service numeric;
    pending boolean := false;
begin
    if p_rate < 0 or p_rate > 100 then
        raise exception 'Taxa de serviço inválida no caixa.' using errcode = '22023';
    end if;
    for entry in select value from jsonb_array_elements(p_state -> 'orders') loop
        if entry ->> 'type' = 'MESA' and entry ->> 'mesa' = p_table::text
            and coalesce((entry ->> 'paid')::boolean, false) = false
            and entry ->> 'status' <> 'CANCELADO' then
            if coalesce((entry ->> 'discount')::numeric, 0) <> 0 or coalesce((entry ->> 'removedService')::numeric, 0) <> 0 then
                raise exception 'Mesa % possui ajustes anteriores; confira antes de unificar.', p_table using errcode = '22023';
            end if;
            if jsonb_typeof(entry -> 'items') is distinct from 'array' then
                raise exception 'Itens inválidos na mesa %.', p_table using errcode = '22023';
            end if;
            if primary_order is null then primary_order := entry; end if;
            enabled := enabled or coalesce((entry ->> 'serviceEnabled')::boolean, coalesce((entry ->> 'svc')::numeric, 0) > 0);
            fees := fees + coalesce((entry ->> 'taxa')::numeric, 0);
            if jsonb_typeof(entry -> 'tableBatches') = 'array' then
                batches := batches || (entry -> 'tableBatches');
                items := items || (entry -> 'items');
                originals := originals || coalesce(entry -> 'tableOriginalOrders', '[]'::jsonb);
            else
                batch_id := 'legacy-' || (entry ->> 'id');
                originals := originals || jsonb_build_array(entry);
                batches := batches || jsonb_build_array(jsonb_build_object(
                    'id', batch_id, 'at', entry -> 'at', 'by', entry -> 'by',
                    'status', entry -> 'status', 'items', entry -> 'items', 'printRequested', false));
                for item in select value from jsonb_array_elements(entry -> 'items') loop
                    items := items || jsonb_build_array(item || jsonb_build_object('tableBatchId', batch_id));
                end loop;
            end if;
        end if;
    end loop;
    if primary_order is null then return p_state; end if;
    for item in select value from jsonb_array_elements(items) loop
        if jsonb_typeof(item -> 'qty') is distinct from 'number' or jsonb_typeof(item -> 'price') is distinct from 'number' then
            raise exception 'Quantidade ou preço inválido na mesa %.', p_table using errcode = '22023';
        end if;
        subtotal := subtotal + (item ->> 'qty')::numeric * (item ->> 'price')::numeric;
    end loop;
    select exists (
        select 1 from jsonb_array_elements(batches) b
        where b ->> 'status' = 'PENDENTE' and exists (
            select 1 from jsonb_array_elements(items) i where i ->> 'tableBatchId' = b ->> 'id'
        )
    ) into pending;
    service := case when enabled then round(subtotal * p_rate / 100, 2) else 0 end;
    primary_order := primary_order || jsonb_build_object(
        'items', items, 'tableBatches', batches, 'tableOriginalOrders', originals,
        'serviceEnabled', enabled, 'svcPct', p_rate, 'sub', subtotal,
        'taxa', fees, 'svc', service, 'total', subtotal + fees + service,
        'status', case when pending then 'PENDENTE' else 'PRONTO' end);
    for entry in select value from jsonb_array_elements(p_state -> 'orders') loop
        if entry ->> 'type' = 'MESA' and entry ->> 'mesa' = p_table::text
            and coalesce((entry ->> 'paid')::boolean, false) = false
            and entry ->> 'status' <> 'CANCELADO' then
            if entry ->> 'id' = primary_order ->> 'id' then
                result_orders := result_orders || jsonb_build_array(primary_order);
            end if;
        else
            result_orders := result_orders || jsonb_build_array(entry);
        end if;
    end loop;
    return jsonb_set(p_state, '{orders}', result_orders);
end;
$$;

revoke all on function public.consolidate_open_table_orders(jsonb, integer, numeric) from public, anon, authenticated;

do $$
declare
    state jsonb;
    original_state jsonb;
    table_number integer;
    service_rate numeric;
begin
    select data into state from public.app_state where id = 'gp_state' for update;
    if state is null then raise exception 'Estado do caixa não encontrado.'; end if;
    original_state := state;
    if state ? '_tableOrderVersion' and state -> '_tableOrderVersion' <> '1'::jsonb then
        raise exception 'Versão de comanda incompatível. Confira a migração antes de continuar.';
    end if;
    state := jsonb_set(state, '{_tableOrderVersion}', '1'::jsonb, true);
    service_rate := coalesce((state -> 'menu' ->> 'svc')::numeric, 10);
    for table_number in 1..50 loop
        state := public.consolidate_open_table_orders(state, table_number, service_rate);
    end loop;
    if state is distinct from original_state then
        update public.app_state set data = state where id = 'gp_state';
    end if;
end;
$$;

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
    table_order jsonb;
    batch_data jsonb;
    tagged_items jsonb := '[]'::jsonb;
    orders_data jsonb := '[]'::jsonb;
    batch_at bigint;
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
    state := public.consolidate_open_table_orders(state, p_table, service_rate);
    select value into table_order from jsonb_array_elements(state -> 'orders')
    where value ->> 'type' = 'MESA' and value ->> 'mesa' = p_table::text
        and coalesce((value ->> 'paid')::boolean, false) = false and value ->> 'status' <> 'CANCELADO'
    limit 1;
    batch_at := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
    batch_data := jsonb_build_object(
        'id', p_request_id, 'at', batch_at, 'by', employee.name, 'status', 'PENDENTE',
        'items', p_items, 'printRequested', true, 'onlineOrderPrint', true);
    for item in select value from jsonb_array_elements(p_items) loop
        tagged_items := tagged_items || jsonb_build_array(item || jsonb_build_object('tableBatchId', p_request_id));
    end loop;
    if table_order is not null then
        subtotal := subtotal + (table_order ->> 'sub')::numeric;
        service_amount := case when (table_order ->> 'serviceEnabled')::boolean then round(subtotal * service_rate / 100, 2) else 0 end;
        order_data := table_order || jsonb_build_object(
            'items', (table_order -> 'items') || tagged_items,
            'tableBatches', (table_order -> 'tableBatches') || jsonb_build_array(batch_data),
            'sub', subtotal, 'svc', service_amount, 'svcPct', service_rate,
            'total', subtotal + coalesce((table_order ->> 'taxa')::numeric, 0) + service_amount,
            'status', 'PENDENTE');
        for item in select value from jsonb_array_elements(state -> 'orders') loop
            orders_data := orders_data || jsonb_build_array(
                case when item ->> 'id' = table_order ->> 'id' then order_data else item end);
        end loop;
        state := jsonb_set(state, '{orders}', orders_data);
    else
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
        'at', batch_at, 'items', tagged_items, 'serviceEnabled', p_service,
        'tableBatches', jsonb_build_array(batch_data), 'tableOriginalOrders', '[]'::jsonb,
        'printRequested', true, 'onlineOrderPrint', true, 'tableRequestId', p_request_id
    );
    state := jsonb_set(state, '{orders}', (state -> 'orders') || jsonb_build_array(order_data));
    state := jsonb_set(state, '{seq}', to_jsonb(order_id + 1), true);
    end if;
    update public.app_state set data = state where id = 'gp_state';
    insert into public.table_order_requests (request_id, employee_id, request, order_data)
    values (p_request_id, p_employee_id, request_data, order_data);
    return order_data;
end;
$$;

revoke all on function public.submit_table_order(uuid, bigint, text, text, integer, jsonb, boolean) from public;
grant execute on function public.submit_table_order(uuid, bigint, text, text, integer, jsonb, boolean) to anon, authenticated;

commit;
