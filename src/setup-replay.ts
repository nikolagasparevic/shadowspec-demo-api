import { pool } from "./db";

export type ReplaySetup = {
  orders?: {
    id?: number;
    customerId: number;
    productId: number;
    quantity: number;
    status: string;
  }[];
};

export async function resetReplayDatabase() {
  await pool.query(
    "TRUNCATE TABLE orders RESTART IDENTITY"
  );
}

export async function applyReplaySetup(
  setup?: ReplaySetup
) {
  await resetReplayDatabase();

  if (!setup) {
    return;
  }

  if (setup.orders) {
    for (const order of setup.orders) {
      if (order.id !== undefined) {
        await pool.query(
          `INSERT INTO orders
            (id, customer_id, product_id, quantity, status)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            order.id,
            order.customerId,
            order.productId,
            order.quantity,
            order.status
          ]
        );

        continue;
      }

      await pool.query(
        `INSERT INTO orders
          (customer_id, product_id, quantity, status)
         VALUES ($1, $2, $3, $4)`,
        [
          order.customerId,
          order.productId,
          order.quantity,
          order.status
        ]
      );
    }
  }
}