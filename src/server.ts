import Fastify from "fastify";
import { pool } from "./db";
import { registerShadowSpecAgent } from "./agent";

const app = Fastify({
  logger: true
});

registerShadowSpecAgent(app);

app.get("/", async () => {
  return {
    message: "ShadowSpec Demo API is alive"
  };
});

app.post("/orders", async (request, reply) => {
  const body = request.body as {
    customerId: number;
    productId: number;
    quantity: number;
  };

  const result = await pool.query(
    `INSERT INTO orders (customer_id, product_id, quantity, status)
     VALUES ($1, $2, $3, $4)
     RETURNING id, customer_id, product_id, quantity, status`,
    [body.customerId, body.productId, body.quantity, "created"]
  );

  const order = result.rows[0];

  const responseBody = {
    orderId: order.id,
    customerId: order.customer_id,
    productId: order.product_id,
    quantity: order.quantity,
    status: order.status
  };

  return reply.code(201).send(responseBody);
});

app.get("/orders/:id", async (request, reply) => {
  const params = request.params as {
    id: string;
  };

  const result = await pool.query(
    `SELECT id, customer_id, product_id, quantity, status
     FROM orders
     WHERE id = $1`,
    [Number(params.id)]
  );

  if (result.rows.length === 0) {
    return reply.code(404).send({
      error: "Order not found"
    });
  }

  const order = result.rows[0];

  return reply.code(200).send({
    orderId: order.id,
    customerId: order.customer_id,
    productId: order.product_id,
    quantity: order.quantity,
    status: order.status
  });
});

app.get("/orders", async (request, reply) => {
  const query = request.query as {
    customerId?: string;
  };

  const customerId = query.customerId
    ? Number(query.customerId)
    : undefined;

  let result;

if (customerId !== undefined) {
  // INTENTIONAL REGRESSION:
  // customerId is received but ignored.
  result = await pool.query(
    `SELECT id, customer_id, product_id, quantity, status
     FROM orders
     ORDER BY id ASC`
  );
} else {
    result = await pool.query(
      `SELECT id, customer_id, product_id, quantity, status
       FROM orders
       ORDER BY id ASC`
    );
  }

  const responseBody = result.rows.map((order) => ({
    orderId: order.id,
    customerId: order.customer_id,
    productId: order.product_id,
    quantity: order.quantity,
    status: order.status
  }));

  return reply.code(200).send(responseBody);
});

app.listen({ port: 3000, host: "0.0.0.0" });