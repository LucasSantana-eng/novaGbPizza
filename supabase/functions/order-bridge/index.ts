import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY secret.");
}

const adminClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const jsonResponse = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function broadcastOnlineEvent(channelName: string, event: string, payload: Record<string, unknown>) {
  const channel = adminClient.channel(channelName, { config: { private: false } });
  let subscriptionTimeout: ReturnType<typeof setTimeout> | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      subscriptionTimeout = setTimeout(
        () => reject(new Error("Realtime channel subscription timed out.")),
        5000,
      );
      channel.subscribe(status => {
        if (status === "SUBSCRIBED") {
          if (subscriptionTimeout) clearTimeout(subscriptionTimeout);
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          if (subscriptionTimeout) clearTimeout(subscriptionTimeout);
          reject(new Error(`Realtime channel status: ${status}`));
        }
      });
    });

    const result = await channel.send({ type: "broadcast", event, payload });
    if (result !== "ok") console.error(`Realtime broadcast returned ${result} for ${channelName}.`);
  } catch (error) {
    console.error(`Realtime notification failed for ${channelName}:`, error);
  } finally {
    if (subscriptionTimeout) clearTimeout(subscriptionTimeout);
    try {
      await adminClient.removeChannel(channel);
    } catch (error) {
      console.error(`Could not remove Realtime channel ${channelName}:`, error);
    }
  }
}

async function authorizeStaff(body: Record<string, unknown>) {
  const id = body.userId;
  const pin = body.pin;
  if ((typeof id !== "string" && typeof id !== "number") || typeof pin !== "string" || !/^\d{4,8}$/.test(pin)) {
    return null;
  }

  const { data, error } = await adminClient
    .from("usuarios")
    .select("id, name, role, pin, active")
    .eq("id", id)
    .eq("active", true)
    .maybeSingle();

  if (error) throw error;
  const requiredPinLength = ["ADMIN", "GERENTE", "CAIXA"].includes(data?.role) ? 8 : 4;
  if (!data || String(data.pin) !== pin || pin.length !== requiredPinLength) return null;
  return { id: data.id, name: data.name, role: data.role };
}

function isValidOrder(payload: unknown) {
  if (!payload || typeof payload !== "object") return false;
  const order = payload as Record<string, unknown>;
  const customer = order.customer as Record<string, unknown> | undefined;
  const items = order.items;
  const phone = typeof customer?.phone === "string" ? customer.phone.trim() : "";
  const itemsAreValid = Array.isArray(items) && items.length > 0 && items.length <= 30 &&
    items.every(item => item && typeof item.name === "string" && item.name.trim().length > 0 &&
      item.name.length <= 120 && typeof item.size === "string" && item.size.length <= 60 &&
      Number.isInteger(item.qty) && item.qty > 0 && item.qty <= 50 &&
      Number.isFinite(item.price) && item.price >= 0 && item.price <= 100000 &&
      (["Média", "Grande", "Família"].includes(item.size)
        ? Array.isArray(item.flavors) &&
          item.flavors.length > 0 &&
          item.flavors.length <= ({ "Média": 2, "Grande": 3, "Família": 4 }[item.size] || 0) &&
          item.flavors.every(flavor => typeof flavor === "string" && flavor.trim().length > 0 && flavor.length <= 100) &&
          new Set(item.flavors).size === item.flavors.length
        : item.flavors === undefined || (Array.isArray(item.flavors) && item.flavors.length === 0)));
  const subtotal = Array.isArray(items) && itemsAreValid
    ? items.reduce((sum, item) => sum + item.qty * item.price, 0)
    : Number.NaN;
  const deliveryFee = Number(order.deliveryFee);
  const changeFieldsAreValid = order.needsChange === undefined
    ? order.cashChangeFor === undefined
    : order.payment === "Dinheiro" && typeof order.needsChange === "boolean" &&
      (order.needsChange
        ? typeof order.cashChangeFor === "number" && Number.isFinite(order.cashChangeFor) &&
          order.cashChangeFor <= 1000000 && order.cashChangeFor > Number(order.total) &&
          Math.abs(order.cashChangeFor * 100 - Math.round(order.cashChangeFor * 100)) < 0.000001
        : order.cashChangeFor === undefined);

  return typeof customer?.name === "string" && customer.name.trim().length > 0 &&
    customer.name.length <= 120 &&
    phone.length <= 30 && /^[+()\d\s.-]{8,30}$/.test(phone) &&
    (order.deliveryType === "delivery" || order.deliveryType === "pickup") &&
    (order.deliveryType !== "delivery" || (typeof order.address === "string" &&
      order.address.trim().length > 0 && order.address.length <= 300)) &&
    (typeof order.complement === "string" && order.complement.length <= 300) &&
    itemsAreValid && Number.isFinite(deliveryFee) && deliveryFee >= 0 && deliveryFee <= 1000 &&
    typeof order.subtotal === "number" && Number.isFinite(order.subtotal) &&
    Math.abs(order.subtotal - subtotal) < 0.01 &&
    typeof order.total === "number" && Number.isFinite(order.total) &&
    order.total >= 0 && order.total <= 1000000 &&
    Math.abs(Number(order.total) - subtotal - deliveryFee) < 0.01 &&
    (order.deliveryType === "delivery" || deliveryFee === 0) &&
    typeof order.payment === "string" && order.payment.length <= 60 && changeFieldsAreValid;
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  try {
    const body = await request.json() as Record<string, unknown>;

    if (body.action === "submit_order") {
      const { requestId, trackingToken, payload } = body;
      if (typeof requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(requestId) ||
        typeof trackingToken !== "string" || !/^[0-9a-f]{64}$/i.test(trackingToken) ||
        !isValidOrder(payload)) {
        return jsonResponse(400, { error: "Invalid order data." });
      }
      const trackingHash = await sha256(trackingToken);
      const { data, error } = await adminClient
        .from("online_orders")
        .insert({ client_request_id: requestId, tracking_hash: trackingHash, payload })
        .select("id, status, created_at")
        .single();

      if (error?.code === "23505") {
        const { data: existing, error: existingError } = await adminClient
          .from("online_orders")
          .select("id, status, created_at")
          .eq("client_request_id", requestId)
          .eq("tracking_hash", trackingHash)
          .maybeSingle();
        if (existingError) throw existingError;
        if (existing) return jsonResponse(200, { order: existing });
        return jsonResponse(409, { error: "Request ID already exists." });
      }
      if (error) throw error;
      await broadcastOnlineEvent("online-orders-notifications", "order-update", {
        orderId: data.id,
        status: data.status,
      });
      return jsonResponse(201, { order: data });
    }

    if (body.action === "order_status") {
      const { orderId, trackingToken } = body;
      if (typeof orderId !== "string" || typeof trackingToken !== "string" ||
        !/^[0-9a-f]{64}$/i.test(trackingToken)) {
        return jsonResponse(400, { error: "Invalid tracking data." });
      }
      const { data, error } = await adminClient
        .from("online_orders")
        .select("id, status, rejection_reason")
        .eq("id", orderId)
        .eq("tracking_hash", await sha256(trackingToken))
        .maybeSingle();
      if (error) throw error;
      if (!data) return jsonResponse(404, { error: "Pedido não encontrado." });
      return jsonResponse(200, { order: data });
    }

    if (body.action === "staff_list") {
      const staff = await authorizeStaff(body);
      if (!staff) return jsonResponse(401, { error: "Acesso não autorizado." });
      const { data, error } = await adminClient
        .from("online_orders")
        .select("id, status, payload, created_at, pos_imported")
        .or("status.eq.pending,and(status.eq.accepted,pos_imported.eq.false)")
        .order("created_at", { ascending: true })
        .limit(50);
      if (error) throw error;
      return jsonResponse(200, { orders: data || [] });
    }

    if (body.action === "staff_accept" || body.action === "staff_reject") {
      const staff = await authorizeStaff(body);
      if (!staff) return jsonResponse(401, { error: "Acesso não autorizado." });
      if (typeof body.orderId !== "string") return jsonResponse(400, { error: "Invalid order id." });

      const status = body.action === "staff_accept" ? "accepted" : "rejected";
      const update = adminClient
        .from("online_orders")
        .update({
          status,
          ...(status === "accepted" ? { pos_imported: false } : {
            rejection_reason: typeof body.reason === "string" ? body.reason.slice(0, 300) : null,
          }),
        })
        .eq("id", body.orderId)
        .eq("status", "pending");
      const { data, error } = await update
        .select("id, status, payload, created_at, tracking_hash, rejection_reason")
        .maybeSingle();
      if (error) throw error;
      if (!data) return jsonResponse(409, { error: "Este pedido já foi processado por outro operador." });
      const notifications = Promise.all([
        broadcastOnlineEvent("online-orders-notifications", "order-update", {
          orderId: data.id,
          status: data.status,
        }),
        broadcastOnlineEvent(`order-status-${data.tracking_hash}`, "order-status", {
          orderId: data.id,
          status: data.status,
        }),
      ]);
      EdgeRuntime.waitUntil(notifications);
      const order = { ...data };
      delete order.tracking_hash;
      return jsonResponse(200, { order, handledBy: staff.name });
    }

    if (body.action === "staff_imported") {
      const staff = await authorizeStaff(body);
      if (!staff) return jsonResponse(401, { error: "Acesso não autorizado." });
      if (typeof body.orderId !== "string") return jsonResponse(400, { error: "Invalid order id." });
      const { data, error } = await adminClient
        .from("online_orders")
        .update({ pos_imported: true })
        .eq("id", body.orderId)
        .eq("status", "accepted")
        .eq("pos_imported", false)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!data) return jsonResponse(409, { error: "Pedido já importado ou não aceito." });
      return jsonResponse(200, { imported: true });
    }

    if (typeof body.action === "string" && body.action.startsWith("table_preview_")) {
      const staff = await authorizeStaff(body);
      if (!staff) return jsonResponse(401, { error: "Acesso não autorizado." });
      const targetId = body.targetId;
      if (typeof targetId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(targetId)) {
        return jsonResponse(400, { error: "Destino de impressão inválido." });
      }

      if (body.action === "table_preview_create") {
        const bill = body.bill as Record<string, unknown> | null;
        if (!bill || bill.type !== "MESA" || bill.accountPreview !== true ||
          typeof bill.mesa !== "number" || !Number.isInteger(bill.mesa) || bill.mesa < 1 ||
          !Array.isArray(bill.items) || !bill.items.length ||
          JSON.stringify(bill).length > 100000) {
          return jsonResponse(400, { error: "Pré-conta inválida." });
        }
        const { error: cleanupError } = await adminClient.from("table_preview_print_jobs")
          .delete().lt("created_at", new Date(Date.now() - 86400000).toISOString());
        if (cleanupError) throw cleanupError;
        const { data, error } = await adminClient.from("table_preview_print_jobs")
          .insert({ requested_by: String(staff.id), target_id: targetId, bill })
          .select("id").single();
        if (error) throw error;
        return jsonResponse(201, { jobId: data.id });
      }

      if (body.action === "table_preview_claim") {
        const cutoff = new Date(Date.now() - 60000).toISOString();
        const { data: pending, error: listError } = await adminClient.from("table_preview_print_jobs")
          .select("id").eq("target_id", targetId).eq("status", "pending")
          .gte("created_at", cutoff).order("created_at", { ascending: true }).limit(1).maybeSingle();
        if (listError) throw listError;
        if (!pending) return jsonResponse(200, { job: null });
        const { data, error } = await adminClient.from("table_preview_print_jobs")
          .update({ status: "printing" }).eq("id", pending.id).eq("target_id", targetId)
          .eq("status", "pending").select("id,bill").maybeSingle();
        if (error) throw error;
        return jsonResponse(200, { job: data });
      }

      if (typeof body.jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.jobId)) {
        return jsonResponse(400, { error: "Solicitação de impressão inválida." });
      }
      if (body.action === "table_preview_result") {
        if (typeof body.printed !== "boolean") return jsonResponse(400, { error: "Resultado de impressão inválido." });
        const { data, error } = await adminClient.from("table_preview_print_jobs")
          .update({ status: body.printed ? "printed" : "failed" }).eq("id", body.jobId)
          .eq("target_id", targetId).eq("status", "printing").select("id").maybeSingle();
        if (error) throw error;
        if (!data) return jsonResponse(409, { error: "Solicitação de impressão não encontrada." });
        return jsonResponse(200, { updated: true });
      }
      if (body.action === "table_preview_status") {
        const { data, error } = await adminClient.from("table_preview_print_jobs")
          .select("status").eq("id", body.jobId).eq("target_id", targetId)
          .eq("requested_by", String(staff.id)).maybeSingle();
        if (error) throw error;
        if (!data) return jsonResponse(404, { error: "Solicitação de impressão não encontrada." });
        return jsonResponse(200, { status: data.status });
      }
    }

    return jsonResponse(400, { error: "Unknown action." });
  } catch (error) {
    console.error("order-bridge error:", error);
    return jsonResponse(500, { error: "Falha ao processar o pedido. Tente novamente." });
  }
});
