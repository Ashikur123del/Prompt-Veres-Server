# PromptVerse Server — AI Prompt Marketplace API

Express REST API for the PromptVerse AI Prompt Sharing & Marketplace Platform.

## Live URL

- **API:** `https://your-api.vercel.app` *(update after deployment)*

## Tech Stack

- Node.js, Express 5
- MongoDB (native driver)
- JWT verification via better-auth JWKS (jose)
- Stripe for Premium payments
- CORS-enabled for frontend origin

## Environment Setup

1. Copy the example env file:

```bash
cp .env.example .env
```

2. Fill in all variables:

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 5000) |
| `MONGO_DB_URI` | MongoDB connection string |
| `CLIENT_URL` | Frontend URL for CORS |
| `AUTH_SERVER_URL` | Frontend URL for JWT JWKS verification |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |

## Run Locally

```bash
npm install
npm start
```

Server runs on `http://localhost:5000`.

## API Routes

### Public
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/prompts` | List prompts (search, filter, sort, pagination) |
| GET | `/api/prompts/featured` | Top 6 featured prompts |
| GET | `/api/prompts/:id` | Single prompt details |
| GET | `/api/creators/top` | Top 3 creators (aggregation) |
| GET | `/api/reviews/recent` | Recent reviews for homepage |
| GET | `/api/reviews/:promptId` | Reviews for a prompt |
| PATCH | `/api/prompts/:id/copy` | Increment copy count |

### Authenticated
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/prompts` | Create prompt |
| GET | `/api/prompts/my-prompts` | User's prompts |
| PATCH/DELETE | `/api/prompts/:id` | Update/delete own prompt |
| POST/GET | `/api/bookmarks` | Toggle/list bookmarks |
| GET | `/api/bookmarks/check/:promptId` | Check bookmark status |
| POST | `/api/reviews` | Submit review |
| POST | `/api/reports` | Report a prompt |
| GET | `/api/users/me` | User profile stats |
| POST | `/api/payments/create-checkout-session` | Stripe checkout |
| GET | `/api/creator/analytics` | Creator dashboard data |

### Admin
| Method | Route | Description |
|--------|-------|-------------|
| GET/PATCH/DELETE | `/api/admin/users` | Manage users |
| GET/PATCH/DELETE | `/api/admin/prompts` | Moderate prompts |
| GET | `/api/admin/payments` | View payments |
| GET/PATCH | `/api/admin/reports` | Handle reports |
| GET | `/api/admin/analytics` | Platform analytics |

### Webhooks
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/webhooks/stripe` | Stripe payment webhook |

## Deployment (Vercel)

1. Set all environment variables in Vercel dashboard
2. Set `CLIENT_URL` and `AUTH_SERVER_URL` to your deployed frontend URL
3. Configure Stripe webhook URL: `https://your-api.vercel.app/api/webhooks/stripe`

## MongoDB Collections

- `prompts` — Marketplace prompts
- `user` — Users (better-auth)
- `bookmarks` — Saved prompts
- `reviews` — Prompt reviews
- `reports` — Reported prompts
- `payments` — Stripe transactions
