import "server-only";

import { ExternalAccountClient } from "google-auth-library";
import { getVercelOidcToken } from "@vercel/oidc";

export interface GcpWorkloadIdentityConfiguration {
  projectNumber: string;
  serviceAccountEmail: string;
  workloadIdentityPoolId: string;
  workloadIdentityPoolProviderId: string;
}

/**
 * Exchanges the request-scoped Vercel OIDC JWT for short-lived Google credentials.
 * No Google service-account key is stored in Vercel or source control.
 */
export function createGcpWorkloadIdentityClient(config: GcpWorkloadIdentityConfiguration) {
  // Ask Vercel to mint a token exclusively for this Google WIF provider. This
  // prevents the token from being accepted by a different relying party.
  const oidcAudience = `https://iam.googleapis.com/projects/${config.projectNumber}/locations/global/workloadIdentityPools/${config.workloadIdentityPoolId}/providers/${config.workloadIdentityPoolProviderId}`;
  const client = ExternalAccountClient.fromJSON({
    type: "external_account",
    audience: `//iam.googleapis.com/projects/${config.projectNumber}/locations/global/workloadIdentityPools/${config.workloadIdentityPoolId}/providers/${config.workloadIdentityPoolProviderId}`,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(config.serviceAccountEmail)}:generateAccessToken`,
    subject_token_supplier: {
      getSubjectToken: () => getVercelOidcToken({ audience: oidcAudience }),
    },
  });
  if (!client) throw new Error("Unable to initialize Google workload identity credentials");
  return client;
}
