import IORedis from "ioredis";

const RedisConstructor = (IORedis as any).default || IORedis;
const redis = new RedisConstructor(process.env.REDIS_URL || "redis://localhost:6379");

export { redis };
export default redis;
