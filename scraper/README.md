# Sales Scraper Service

Lead scraper for Mexican business directories (Páginas Amarillas, Sección Amarilla).

## Features
- Rate-limited scraping (respectful)
- PostgreSQL storage with deduplication
- Redis caching
- Health monitoring
- Metrics endpoint

## Environment Variables
- `DATABASE_URL`: PostgreSQL connection
- `REDIS_URL`: Redis connection  
- `SCRAPER_INTERVAL`: Scraping frequency (seconds)
- `MAX_CONCURRENT_REQUESTS`: Rate limiting
