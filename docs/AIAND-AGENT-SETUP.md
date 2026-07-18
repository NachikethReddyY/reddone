# ai& agent setup

This project uses ai& through the OpenAI-compatible API. Operators can choose a model when they start a manual **Research**, **Generate ProductSpec**, or **Build** workflow.

## Supported workflow models

| UI label | ai& model ID | Best fit |
| --- | --- | --- |
| GLM-5.2 | `zai-org/glm-5.2` | Large-context research and complex reasoning |
| Kimi K2.7 Code | `moonshotai/kimi-k2.7-code` | Code generation and tool-calling builds |

The selection is stored on the workflow run. All steps of that run use the same model, and a retry retains the original selection. Scheduled workflows use Kimi K2.7 Code by default.

See the live ai& catalog before changing these model IDs: <https://docs.aiand.com/models/catalog/>.

## What the agent must do

1. Start the project locally or deploy it with the environment variables in [Railway configuration](./RAILWAY-AIAND-ENV.md).
2. Create or open a project.
3. Choose one model from the selector immediately before starting a workflow:
   - **Run research** for discovery.
   - **Generate ProductSpec** after selecting a finding.
   - **Start build** after the ProductSpec is approved.
4. Treat the displayed provider-cost ceiling as a hard stop, not an estimate.
5. Never place `AIAND_API_KEY` in a project secret, generated app, browser code, chat message, or source-controlled file. It is backend infrastructure only.

## API behavior

The server sends requests through the official `openai` Node SDK with:

```ts
new OpenAI({
  apiKey: process.env.AIAND_API_KEY,
  baseURL: "https://api.aiand.com/v1",
});
```

The model ID selected for the run is passed unchanged as the OpenAI `model` value. The application records usage and model attribution against the run.

## Local setup

Add these values to a gitignored `.env.local` file:

```env
AIAND_API_KEY=sk-your-aiand-key

# Conservative maximum of the two supported models' published ai& rates.
KIMI_INPUT_COST_MICROS_PER_MILLION=1000000
KIMI_OUTPUT_COST_MICROS_PER_MILLION=4000000
```

The legacy `KIMI_API_KEY` and `MOONSHOT_API_KEY` variables remain supported for direct Moonshot deployments, but do not set them when the intended provider is ai&.

Then apply the model-selection migration and start the app:

```bash
pnpm db:deploy
pnpm dev
```

## Cost guardrail

ai& currently lists GLM-5.2 at $1.00 input / $4.00 output per million tokens and Kimi K2.7 Code at $0.75 input / $3.50 output per million tokens. This project’s existing `KIMI_*_COST_MICROS_PER_MILLION` variables are used for its durable budget guardrail; configure them to the higher GLM-5.2 rates above so either selectable model is conservatively budgeted.

Do not change model IDs or pricing variables without a human review of the current ai& catalog and the project’s billing policy.
