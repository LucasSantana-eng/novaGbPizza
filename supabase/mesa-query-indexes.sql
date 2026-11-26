-- Índices para as consultas existentes de comandas e itens.
-- Não sincronizam as mesas com o caixa nem alteram registros existentes.
CREATE INDEX IF NOT EXISTS comandas_mesa_status_aberta_em_idx
    ON public.comandas (mesa_numero, status, aberta_em DESC);

CREATE INDEX IF NOT EXISTS mesa_itens_comanda_criado_em_idx
    ON public.mesa_itens (comanda_id, criado_em);
