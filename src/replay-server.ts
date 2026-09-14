import Fastify from "fastify";
import { pool } from "./db";

const app = Fastify({
  logger: true
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
    [body.customerId, body.productId, body.quantity, "pending"]
  );

  const order = result.rows[0];

  return reply.code(201).send({
    orderId: order.id,
    customerId: order.customer_id,
    productId: order.product_id,
    quantity: order.quantity,
    status: order.status
  });
});

app.get("/orders", async (request, reply) => {
  const result = await pool.query(
    `SELECT id, customer_id, product_id, quantity, status
     FROM orders
     ORDER BY id ASC`
  );

  const responseBody = result.rows.map((order) => ({
    orderId: order.id,
    customerId: order.customer_id,
    productId: order.product_id,
    quantity: order.quantity,
    status: order.status
  }));

  return reply.code(200).send(responseBody);
});

app.listen({ port: 3001, host: "0.0.0.0" });