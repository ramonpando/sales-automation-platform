// =============================================
// APIFY SCRAPER SERVICE - ENHANCED SCRAPING
// =============================================

const { Actor } = require('apify');
const { CheerioCrawler, Dataset } = require('crawlee');

class ApifyScraperService {
  constructor(logger, metricsService) {
    this.logger = logger || console;
    this.metricsService = metricsService;
    this.isInitialized = false;
  }

  // =============================================
  // INITIALIZATION
  // =============================================

  async initialize() {
    try {
      this.logger.info('🚀 Initializing Apify Scraper Service...');
      
      // Initialize Apify if we have a token
      if (process.env.APIFY_TOKEN) {
        await Actor.init({
          token: process.env.APIFY_TOKEN
        });
        this.logger.info('✅ Apify initialized with token');
      } else {
        // Local mode without token
        await Actor.init();
        this.logger.info('✅ Apify initialized in local mode');
      }

      this.isInitialized = true;
    } catch (error) {
      this.logger.error('Failed to initialize Apify', error);
      throw error;
    }
  }

  // =============================================
  // PÁGINAS AMARILLAS SCRAPER
  // =============================================

  async scrapePaginasAmarillasEnhanced(category, location, limit = 100) {
    const startTime = Date.now();
    const results = [];
    
    try {
      this.logger.info('Starting Páginas Amarillas scraping with Apify', {
        category,
        location,
        limit
      });

      // Create request list
      const baseUrl = 'https://www.paginasamarillas.com.mx/busqueda';
      const requests = [];
      
      // Generate URLs for multiple pages
      for (let page = 1; page <= Math.ceil(limit / 20); page++) {
        requests.push({
          url: `${baseUrl}/${category}/${location}?page=${page}`,
          userData: { page, category, location }
        });
      }

      // Create crawler
      const crawler = new CheerioCrawler({
        requestHandlerTimeoutSecs: 30,
        maxRequestRetries: 3,
        maxConcurrency: 5,
        
        async requestHandler({ request, $, crawler }) {
          const timer = this.metricsService.startTimer('paginas_amarillas_page');
          
          try {
            this.logger.info(`Processing page ${request.userData.page}`, {
              url: request.url
            });

            // Extract listings
            const listings = [];
            
            $('.listado-item, .m-results-business').each((index, element) => {
              const $item = $(element);
              
              const listing = {
                businessName: this.cleanText($item.find('.comercio-title, .m-results-business--name').text()),
                phone: this.extractPhone($item.find('.phone, .telefono').text()),
                address: this.cleanText($item.find('.direccion, .m-results-business--address').text()),
                category: this.cleanText($item.find('.categoria, .m-results-business--category').text()),
                website: $item.find('a[href*="sitio-web"]').attr('href'),
                email: this.extractEmail($item.html()),
                
                // Additional data from enhanced scraping
                rating: this.extractRating($item),
                reviewCount: this.extractReviewCount($item),
                businessHours: this.extractBusinessHours($item),
                services: this.extractServices($item),
                
                // Metadata
                source: 'paginas_amarillas_apify',
                scrapedAt: new Date().toISOString(),
                pageUrl: request.url,
                position: index + 1,
                page: request.userData.page
              };

              if (listing.businessName && (listing.phone || listing.address)) {
                listings.push(listing);
              }
            });

            // Store in Apify dataset
            await Dataset.pushData(listings);
            
            // Add to results
            results.push(...listings);
            
            this.logger.info(`Extracted ${listings.length} listings from page ${request.userData.page}`);
            
            // Record metrics
            timer.end();
            this.metricsService.recordLeadProcessed('paginas_amarillas', 'found', true);
            
            // Check for next page
            const nextPageLink = $('.pagination .next').attr('href');
            if (nextPageLink && results.length < limit) {
              await crawler.addRequests([{
                url: new URL(nextPageLink, request.url).href,
                userData: { ...request.userData, page: request.userData.page + 1 }
              }]);
            }
            
          } catch (error) {
            this.logger.error('Error processing page', {
              url: request.url,
              error: error.message
            });
            timer.end();
            throw error;
          }
        },
        
        failedRequestHandler({ request, error }) {
          this.logger.error('Request failed', {
            url: request.url,
            error: error.message
          });
          this.metricsService.recordRequest('scraper', 'paginas_amarillas', 'error');
        }
      });

      // Run the crawler
      await crawler.run(requests);
      
      // Get all data from dataset
      const dataset = await Dataset.open();
      const { items } = await dataset.getData();
      
      const duration = Date.now() - startTime;
      
      this.logger.info('Páginas Amarillas scraping completed', {
        totalResults: items.length,
        duration: `${duration}ms`,
        pagesProcessed: Math.ceil(items.length / 20)
      });

      return {
        success: true,
        source: 'paginas_amarillas_apify',
        results: items.slice(0, limit),
        metadata: {
          totalFound: items.length,
          duration,
          timestamp: new Date().toISOString()
        }
      };

    } catch (error) {
      this.logger.error('Páginas Amarillas scraping failed', error);
      throw error;
    }
  }

  // =============================================
  // GOOGLE MY BUSINESS SCRAPER
  // =============================================

  async scrapeGoogleMyBusiness(category, location, limit = 50) {
    const startTime = Date.now();
    
    try {
      this.logger.info('Starting Google My Business scraping', {
        category,
        location,
        limit
      });

      // For GMB, we would use a specialized actor
      const run = await Actor.call('compass/google-maps-scraper', {
        queries: [`${category} in ${location}`],
        maxCrawledPlacesPerSearch: limit,
        language: 'es',
        reviewsSort: 'newest',
        scrapeReviewerName: true,
        scrapeReviewerUrl: true,
        scrapeReviewId: true,
        scrapeReviewUrl: true,
        scrapeResponseFromOwnerText: true
      });

      const { items } = await Dataset.getData(run.defaultDatasetId);
      
      // Transform GMB data to our format
      const results = items.map((item, index) => ({
        businessName: item.title,
        phone: item.phoneNumber,
        address: item.address,
        website: item.website,
        email: this.extractEmailFromText(item.description),
        
        // GMB specific data
        googlePlaceId: item.placeId,
        rating: item.rating,
        reviewCount: item.totalReviews,
        priceLevel: item.priceLevel,
        businessHours: item.openingHours,
        categories: item.categories,
        latitude: item.location?.lat,
        longitude: item.location?.lng,
        photos: item.photos?.slice(0, 3),
        
        // Metadata
        source: 'google_my_business',
        scrapedAt: new Date().toISOString(),
        position: index + 1
      }));

      const duration = Date.now() - startTime;
      
      return {
        success: true,
        source: 'google_my_business',
        results,
        metadata: {
          totalFound: results.length,
          duration,
          timestamp: new Date().toISOString()
        }
      };

    } catch (error) {
      this.logger.error('Google My Business scraping failed', error);
      
      // Fallback to basic GMB scraping
      return this.basicGooglePlacesScraping(category, location, limit);
    }
  }

  // =============================================
  // LINKEDIN SCRAPER (EXAMPLE)
  // =============================================

  async scrapeLinkedInCompanies(industry, location, limit = 20) {
    try {
      this.logger.info('Starting LinkedIn companies scraping', {
        industry,
        location,
        limit
      });

      // LinkedIn requires special handling and cookies
      // This is a simplified example
      const run = await Actor.call('curious_coder/linkedin-companies-scraper', {
        searchUrl: `https://www.linkedin.com/search/results/companies/?keywords=${industry}%20${location}`,
        maxResults: limit,
        cookie: process.env.LINKEDIN_COOKIE // Required
      });

      const { items } = await Dataset.getData(run.defaultDatasetId);
      
      return {
        success: true,
        source: 'linkedin',
        results: items,
        metadata: {
          totalFound: items.length,
          timestamp: new Date().toISOString()
        }
      };

    } catch (error) {
      this.logger.error('LinkedIn scraping failed', error);
      throw error;
    }
  }

  // =============================================
  // UTILITY METHODS
  // =============================================

  cleanText(text) {
    return text ? text.trim().replace(/\s+/g, ' ').replace(/\n/g, '') : '';
  }

  extractPhone(text) {
    if (!text) return null;
    const phoneRegex = /(\+52\s?)?(\d{2,3}[-\s]?\d{3,4}[-\s]?\d{4})/;
    const match = text.match(phoneRegex);
    return match ? match[0].replace(/[-\s]/g, '') : null;
  }

  extractEmail(html) {
    if (!html) return null;
    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;
    const match = html.match(emailRegex);
    return match ? match[0].toLowerCase() : null;
  }

  extractEmailFromText(text) {
    if (!text) return null;
    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/;
    const match = text.match(emailRegex);
    return match ? match[0].toLowerCase() : null;
  }

  extractRating($item) {
    const rating = $item.find('.rating, .stars, .calificacion').attr('data-rating');
    return rating ? parseFloat(rating) : null;
  }

  extractReviewCount($item) {
    const reviewText = $item.find('.reviews, .opiniones').text();
    const match = reviewText.match(/\d+/);
    return match ? parseInt(match[0]) : null;
  }

  extractBusinessHours($item) {
    const hours = [];
    $item.find('.horario, .business-hours').each((i, el) => {
      hours.push(this.cleanText($(el).text()));
    });
    return hours.length > 0 ? hours : null;
  }

  extractServices($item) {
    const services = [];
    $item.find('.servicios li, .services-list span').each((i, el) => {
      services.push(this.cleanText($(el).text()));
    });
    return services.length > 0 ? services : null;
  }

  // =============================================
  // BASIC FALLBACK SCRAPING
  // =============================================

  async basicGooglePlacesScraping(category, location, limit) {
    // Implementación básica sin actor de Apify
    const axios = require('axios');
    const results = [];
    
    try {
      // Usar Google Places API si está disponible
      if (process.env.GOOGLE_PLACES_API_KEY) {
        const response = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
          params: {
            query: `${category} in ${location}`,
            key: process.env.GOOGLE_PLACES_API_KEY,
            language: 'es'
          }
        });

        results.push(...response.data.results.map(place => ({
          businessName: place.name,
          address: place.formatted_address,
          rating: place.rating,
          googlePlaceId: place.place_id,
          source: 'google_places_api'
        })));
      }

      return {
        success: true,
        source: 'google_places_basic',
        results: results.slice(0, limit),
        metadata: {
          totalFound: results.length,
          timestamp: new Date().toISOString()
        }
      };

    } catch (error) {
      this.logger.error('Basic Google Places scraping failed', error);
      return {
        success: false,
        source: 'google_places_basic',
        results: [],
        error: error.message
      };
    }
  }

  // =============================================
  // CLEANUP
  // =============================================

  async cleanup() {
    try {
      await Actor.exit();
      this.logger.info('Apify scraper service cleaned up');
    } catch (error) {
      this.logger.error('Error during cleanup', error);
    }
  }
}

module.exports = ApifyScraperService;
