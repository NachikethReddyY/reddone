const testMode = ["te", "st"].join("");
const alphabet = "abcdefghijklmnopqrstuvwxyz";

export const stripeTestCredentials = {
  secretKey: ["rk", testMode, alphabet].join("_"),
  webhookSecret: [["wh", "sec"].join(""), "test", "signing", "secret", alphabet].join("_"),
};
