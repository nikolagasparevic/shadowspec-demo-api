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
    [body.customerId, body.productId, body.quantity, "created"]
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

app.listen({ port: 3001, host: "0.0.0.0" });