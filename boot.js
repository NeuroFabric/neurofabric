process.env.NEUROFEBRIC_GATEWAY_TOKENS = JSON.stringify([
    { id: "demo", credential: "demo-gw-value", providers: ["portal"] }
]);
import('./start-ui.mjs');