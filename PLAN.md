# LoverBaazar Plan

**Goal:** a modern, fast shop at $0 running cost, ready to move to a VPS or AWS later without a rewrite.

| Part | Choice | At its free limit |
|---|---|---|
| Store and CDN | Astro static pages on Cloudflare | Static traffic is unlimited |
| API routing | Cloudflare Worker | `/api` pauses until 06:00 BD time; browsing continues |
| API | Go on Render Free, Singapore | Service stops or sleeps |
| Database | PostgreSQL on Neon Free, Singapore | Database stops until next month |
| Old images | Static files on Cloudflare | No traffic limit |
| New images | Cloudinary Free | Uploads or delivery stop |
| Order email | Brevo Free | Emails stop; orders still save |
| Deploys, backups | GitHub Actions, private repo | Runs stop until next month |

**Why no card anywhere:** AWS and R2 bill past their limits, with no hard cap. With no card and no paid plan, a limit means a pause, never a bill.

**Why these:** static pages keep browsing up when the API fails. Postgres gives real transactions and runs everywhere. Go has the lowest memory use and fastest start of those tested, so it suits free servers and keeps later bills low.

**Rejected:** Vercel Hobby (terms ban commercial use), Supabase Free (pauses after a week), D1 (forces a database migration later), AWS and R2 (can bill).

**Main compromise:** Render says Free isn't for production. If it sleeps or restarts, checkout may take about a minute. Browsing isn't affected.

## Later

Move only when free limits are really reached:

1. Neon paid plan, for storage and longer restore history.
2. API to a Singapore VPS with Docker (`apps/api/Dockerfile`). Keep Neon.
3. AWS: ECS, RDS, S3 + CloudFront. The Go code stays the same.

## Still to build

Colour filter, popups, phone orders typed into admin, moving customers, old orders and Rank Math SEO text from the WordPress database, and a real payment gateway (SSLCommerz or bKash). Self-service password reset needs SMS or email, so for now the admin sets a new password from Customers.
