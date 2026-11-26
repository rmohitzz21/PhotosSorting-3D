export function importCost(count: number) {
  const price = Number(process.env.BATCH_MAX_USD || 0);
  const enabled = !!process.env.AI_GATEWAY_API_KEY && price > 0;
  return {
    enabled,
    estimate: enabled ? Math.ceil(count / 72) * price * 3 : 0,
    limit: Number(process.env.MONTHLY_LIMIT_USD || 0),
  };
}
