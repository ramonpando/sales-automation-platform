// =============================================
// APIFY SCRAPER SERVICE - ENHANCED SCRAPING (VERSIÓN CORREGIDA)
// =============================================

const { Actor } = require('apify');
const { CheerioCrawler, Dataset } = require('crawlee');

class ApifyScraperService {
  constructor(logger, metricsService) {
    // Verificación defensiva de parámetros
    this.logger = logger || {
      info: (...args) => console.log('[INFO]', ...args),
      error: (...args) => console.error('[ERROR]', ...args),
      warn: (...args) => console.warn('[WARN]', ...args),
      debug: (...args) => console.log('[DEBUG]', ...args)
    };
    
    this.metricsService = metricsService || null;
    this.isInitialized = false;
  }

  // =============================================
  // INITIALIZATION
  // =============================================

  async initialize() {
    try {
      this.logger.info('🚀 Initializing Apify Scraper Service...');
      
      // Verificar si Apify está disponible
      if (!Actor) {
        throw new Error('Apify Actor module not available');
      }
      
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
      return true;
      
    } catch (error) {
      const errorMessage = error && error.message ? error.message : 'Unknown initialization error';
      this.logger.error('Failed to initialize Apify', { 
        error: errorMessage,
        stack: error && error.stack ? error.stack : 'No stack trace available'
      });
      
      // No lanzar el error, permitir que el servicio continúe sin Apify
      this.isInitialized = false;
      return false;
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
          const timer = this.metricsService && this.metricsService.startTimer ? 
                        this.metricsService.startTimer('paginas_amarillas_page') : null;
          
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
            if (timer) timer.end();
            if (this.metricsService && typeof this.metricsService.recordLeadProcessed === 'function') {
              this.metricsService.recordLeadProcessed('paginas_amarillas', 'found', true);
            }
            
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
              error: error && error.message ? error.message : 'Unknown error'
            });
            if (timer) timer.end();
            throw error;
          }
        },
        
        // CORRECCIÓN CRÍTICA: Manejo defensivo de errores
        failedRequestHandler({ request, error }) {
          // Verificación defensiva del objeto error
          const errorMessage = error && error.message ? error.message : 
                              error && typeof error === 'string' ? error : 
                              'Unknown error occurred';
          
          const errorDetails = {
            url: request ? request.url : 'Unknown URL',
            error: errorMessage,
            timestamp: new Date().toISOString()
          };

          this.logger.error('Request failed', errorDetails);
          
          // Verificar que metricsService existe antes de usarlo
          if (this.metricsService && typeof this.metricsService.recordRequest === 'function') {
            try {
              this.metricsService.recordRequest('scraper', 'paginas_amarillas', 'error');
            } catch (metricsError) {
              this.logger.warn('Failed to record metrics', { 
                error: metricsError && metricsError.message ? metricsError.message : metricsError 
              });
            }
          }
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
      const errorMessage = error && error.message ? error.message : 'Unknown scraping error';
      this.logger.error('Páginas Amarillas scraping failed', { 
        error: errorMessage,
        stack: error && error.stack ? error.stack : 'No stack trace'
      });
      throw new Error(`Scraping failed: ${errorMessage}`);
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
      const errorMessage = error && error.message ? error.message : 'Unknown GMB scraping error';
      this.logger.error('Google My Business scraping failed', { error: errorMessage });
      
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
      const errorMessage = error && error.message ? error.message : 'Unknown LinkedIn scraping error';
      this.logger.error('LinkedIn scraping failed', { error: errorMessage });
      throw new Error(`LinkedIn scraping failed: ${errorMessage}`);
    }
  }
  
  // =============================================
  // PYMES.ORG.MX SCRAPER
  // =============================================

  async scrapePymesOrgMx(category, state, limit = 100) {
    const startTime = Date.now();
    const results = [];
    
    try {
      this.logger.info('Starting PYMES.org.mx scraping with Apify', {
        category,
        state,
        limit
      });

      // Create request list
      const baseUrl = 'https://pymes.org.mx';
      const requests = [];
      
      // First, get the category URL
      const categorySlug = this.slugify(category);
      const stateSlug = this.slugify(state);
      
      // PYMES uses URLs like: /estado/categoria/
      requests.push({
        url: `${baseUrl}/${stateSlug}/${categorySlug}/`,
        userData: { 
          type: 'category',
          category, 
          state,
          page: 1 
        }
      });

      // Create crawler
      const crawler = new CheerioCrawler({
        requestHandlerTimeoutSecs: 30,
        maxRequestRetries: 3,
        maxConcurrency: 3, // Be respectful with the site
        
        async requestHandler({ request, $, crawler }) {
          const timer = this.metricsService && this.metricsService.startTimer ? 
                        this.metricsService.startTimer('pymes_page') : null;
          
          try {
            this.logger.info(`Processing ${request.userData.type} page`, {
              url: request.url,
              page: request.userData.page
            });

            if (request.userData.type === 'category') {
              // Extract business listings from category page
              const businessLinks = [];
              
              // PYMES uses different selectors, we need to identify them
              $('.empresa-item, .business-listing, .directorio-item, article.empresa').each((index, element) => {
                const $item = $(element);
                const businessUrl = $item.find('a').attr('href');
                
                if (businessUrl) {
                  const fullUrl = new URL(businessUrl, request.url).href;
                  businessLinks.push(fullUrl);
                  
                  // Add request to scrape business details
                  if (results.length < limit) {
                    crawler.addRequests([{
                      url: fullUrl,
                      userData: {
                        type: 'business',
                        category: request.userData.category,
                        state: request.userData.state
                      }
                    }]);
                  }
                }
              });

              this.logger.info(`Found ${businessLinks.length} businesses on category page`);
              
              // Check for pagination
              const nextPageLink = $('.pagination .next, .paginacion .siguiente, a[rel="next"]').attr('href');
              if (nextPageLink && results.length < limit) {
                await crawler.addRequests([{
                  url: new URL(nextPageLink, request.url).href,
                  userData: { 
                    ...request.userData, 
                    page: request.userData.page + 1 
                  }
                }]);
              }
              
            } else if (request.userData.type === 'business') {
              // Extract business details
              const business = {
                // Basic information
                businessName: this.cleanText(
                  $('h1, .empresa-nombre, .business-name, .titulo-empresa').first().text()
                ),
                
                // Contact information
                phone: this.extractPhone(
                  $('.telefono, .phone, .contacto-telefono, [itemprop="telephone"]').text() ||
                  $('a[href^="tel:"]').attr('href')
                ),
                
                email: this.extractEmail(
                  $('.email, .correo, .contacto-email, [itemprop="email"]').html() ||
                  $('a[href^="mailto:"]').attr('href')
                ),
                
                website: this.cleanUrl(
                  $('.website, .sitio-web, .web, a[href*="http"]:contains("Sitio")').attr('href') ||
                  $('[itemprop="url"]').attr('href')
                ),
                
                // Location
                address: this.cleanText(
                  $('.direccion, .address, .ubicacion, [itemprop="address"]').text()
                ),
                
                city: this.cleanText(
                  $('.ciudad, .city, [itemprop="addressLocality"]').text()
                ),
                
                state: request.userData.state,
                
                // Business details
                category: request.userData.category,
                
                description: this.cleanText(
                  $('.descripcion, .description, .acerca-de, [itemprop="description"]').text()
                ).substring(0, 500),
                
                // Additional information
                services: this.extractListItems($, '.servicios, .services, .lista-servicios'),
                products: this.extractListItems($, '.productos, .products, .lista-productos'),
                
                // Social media
                facebook: $('a[href*="facebook.com"]').attr('href'),
                twitter: $('a[href*="twitter.com"]').attr('href'),
                linkedin: $('a[href*="linkedin.com"]').attr('href'),
                instagram: $('a[href*="instagram.com"]').attr('href'),
                
                // Metadata
                source: 'pymes_org_mx',
                sourceUrl: request.url,
                scrapedAt: new Date().toISOString()
              };

              // Only add if we have a business name and some contact info
              if (business.businessName && (business.phone || business.email || business.address)) {
                results.push(business);
                await Dataset.pushData([business]);
                
                this.logger.debug('Extracted business', {
                  name: business.businessName,
                  phone: business.phone,
                  email: business.email
                });
              }
            }
            
            // Record metrics
            if (timer) timer.end();
            if (this.metricsService && typeof this.metricsService.recordLeadProcessed === 'function') {
              this.metricsService.recordLeadProcessed('pymes_org_mx', 'found', true);
            }
            
          } catch (error) {
            this.logger.error('Error processing page', {
              url: request.url,
              error: error && error.message ? error.message : 'Unknown error'
            });
            if (timer) timer.end();
            throw error;
          }
        },
        
        // CORRECCIÓN: Manejo defensivo de errores
        failedRequestHandler({ request, error }) {
          const errorMessage = error && error.message ? error.message : 
                              error && typeof error === 'string' ? error : 
                              'Unknown error occurred';
          
          this.logger.error('Request failed', {
            url: request ? request.url : 'Unknown URL',
            error: errorMessage,
            timestamp: new Date().toISOString()
          });
          
          if (this.metricsService && typeof this.metricsService.recordRequest === 'function') {
            try {
              this.metricsService.recordRequest('scraper', 'pymes_org_mx', 'error');
            } catch (metricsError) {
              this.logger.warn('Failed to record metrics', { 
                error: metricsError && metricsError.message ? metricsError.message : metricsError 
              });
            }
          }
        }
      });

      // Run the crawler
      await crawler.run(requests);
      
      const duration = Date.now() - startTime;
      
      this.logger.info('PYMES.org.mx scraping completed', {
        totalResults: results.length,
        duration: `${duration}ms`
      });

      return {
        success: true,
        source: 'pymes_org_mx',
        results: results.slice(0, limit),
        metadata: {
          totalFound: results.length,
          duration,
          timestamp: new Date().toISOString(),
          category,
          state
        }
      };

    } catch (error) {
      const errorMessage = error && error.message ? error.message : 'Unknown PYMES scraping error';
      this.logger.error('PYMES.org.mx scraping failed', { error: errorMessage });
      throw new Error(`PYMES scraping failed: ${errorMessage}`);
    }
  }

  // Helper method for PYMES scraper
  extractListItems($, selector) {
    const items = [];
    $(selector).find('li, span, .item').each((i, el) => {
      const text = this.cleanText($(el).text());
      if (text) items.push(text);
    });
    return items.length > 0 ? items : null;
  }

  // Helper method to create URL slugs
  slugify(text) {
    if (!text) return '';
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Remove accents
      .replace(/[^a-z0-9]+/g, '-')     // Replace non-alphanumeric with hyphens
      .replace(/^-+|-+$/g, '');        // Remove leading/trailing hyphens
  }

  // Helper method to clean URLs
  cleanUrl(url) {
    if (!url) return null;
    if (url.startsWith('http')) return url;
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/')) return null; // Relative URL, ignore
    return 'https://' + url;
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
      const errorMessage = error && error.message ? error.message : 'Unknown Google Places error';
      this.logger.error('Basic Google Places scraping failed', { error: errorMessage });
      return {
        success: false,
        source: 'google_places_basic',
        results: [],
        error: errorMessage
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
      const errorMessage = error && error.message ? error.message : 'Unknown cleanup error';
      this.logger.error('Error during cleanup', { error: errorMessage });
    }
  }
}

module.exports = ApifyScraperService;
