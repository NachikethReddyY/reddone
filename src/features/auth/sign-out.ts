export async function signOutOwnerSession() {
  const response = await fetch("/api/v1/account/sign-out", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "idempotency-key": `sign-out-${crypto.randomUUID()}`,
    },
    credentials: "same-origin",
    body: "{}",
  });

  if (!response.ok) throw new Error(`Sign out failed with status ${response.status}.`);
}
