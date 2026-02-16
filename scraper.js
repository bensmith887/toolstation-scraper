const puppeteer = require('puppeteer');

class ToolStationScraper {
  constructor() {
    this.browser = null;
  }

  async init() {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      });
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async search(query, page = 1, perPage = 24) {
    await this.init();
    
    const browserPage = await this.browser.newPage();
    
    try {
      // Set viewport and user agent
      await browserPage.setViewport({ width: 1920, height: 1080 });
      await browserPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      // Navigate to search page
      const url = `https://www.toolstation.com/search?q=${encodeURIComponent(query)}`;
      await browserPage.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      
      // Wait for products to load - look for price elements which indicate products are loaded
      await browserPage.waitForFunction(
        () => {
          const priceElements = document.querySelectorAll('[class*="price"]');
          return priceElements.length > 0;
        },
        { timeout: 15000 }
      ).catch(() => {});
      
      // Additional wait for dynamic content
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Extract product data
      const products = await browserPage.evaluate(() => {
        const results = [];
        const seenProducts = new Set();
        
        // Strategy: Find all links that go to product pages
        const productLinks = Array.from(document.querySelectorAll('a[href]'))
          .filter(a => {
            const href = a.getAttribute('href') || '';
            return href.match(/\/[^\/]+\/p\d+$/);
          });
        
        productLinks.forEach(link => {
          const href = link.getAttribute('href');
          const productCodeMatch = href.match(/\/p(\d+)$/);
          
          if (!productCodeMatch) return;
          
          const productCode = productCodeMatch[1];
          if (seenProducts.has(productCode)) return;
          seenProducts.add(productCode);
          
          // Find the container that has both the link and price
          let container = link;
          let foundContainer = null;
          
          for (let i = 0; i < 15; i++) {
            if (!container || !container.parentElement) break;
            container = container.parentElement;
            
            const text = container.textContent || '';
            
            // Check if this container has price info
            if (text.includes('£') && text.includes('ex. VAT')) {
              foundContainer = container;
              break;
            }
          }
          
          if (!foundContainer) return;
          
          const containerText = foundContainer.textContent || '';
          
          // Extract title - get the longest meaningful text from links in this container
          const titleCandidates = Array.from(foundContainer.querySelectorAll('a[href*="/p"]'))
            .map(a => a.textContent.trim())
            .filter(t => t.length > 10 && !t.includes('Add to') && !t.includes('Collection') && !t.includes('Delivery'))
            .sort((a, b) => b.length - a.length);
          
          const title = titleCandidates[0] || '';
          
          if (!title || title.length < 5) return;
          
          // Extract price (the main price, not ex VAT)
          const priceMatches = containerText.match(/£([\d,]+\.?\d*)/g);
          const price = priceMatches && priceMatches.length > 0 ? priceMatches[0] : null;
          
          // Extract reviews count
          const reviewMatch = containerText.match(/\(\s*(\d+)\s*\)/);
          const reviews = reviewMatch ? parseInt(reviewMatch[1]) : 0;
          
          // Extract image
          const img = foundContainer.querySelector('img');
          let image = null;
          if (img) {
            image = img.src || img.getAttribute('data-src') || null;
          }
          
          // Extract brand from title
          const brandMatch = title.match(/^([A-Z][A-Za-z\s&]+?)(?:\s+[A-Z0-9]|$)/);
          const brand = brandMatch ? brandMatch[1].trim() : null;
          
          results.push({
            productCode,
            title,
            brand,
            price,
            reviews,
            image,
            url: `https://www.toolstation.com${href}`
          });
        });
        
        // Get total results count
        const totalText = document.body.textContent;
        const totalMatch = totalText.match(/(\d+)\s*results/i) || totalText.match(/(\d+)\s*-\s*\d+\s+of\s+(\d+)/i);
        const total = totalMatch ? parseInt(totalMatch[totalMatch.length - 1]) : results.length;
        
        return { results, total };
      });

      await browserPage.close();
      
      return {
        query,
        page,
        perPage,
        total: products.total,
        results: products.results.slice(0, perPage)
      };
      
    } catch (error) {
      await browserPage.close();
      throw new Error(`Search failed: ${error.message}`);
    }
  }

  async getProduct(productCode) {
    await this.init();
    
    const browserPage = await this.browser.newPage();
    
    try {
      // Set viewport and user agent
      await browserPage.setViewport({ width: 1920, height: 1080 });
      await browserPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      // Try to navigate to product page
      const url = `https://www.toolstation.com/p${productCode}`;
      const response = await browserPage.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      
      // Check if page loaded successfully
      if (!response.ok() && response.status() === 404) {
        throw new Error('Product not found');
      }
      
      // Wait for product content
      await browserPage.waitForSelector('h1', { timeout: 10000 });
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Extract product details
      const product = await browserPage.evaluate((code) => {
        const title = document.querySelector('h1')?.textContent?.trim() || null;
        
        // Extract brand
        const brandText = document.body.textContent;
        const brandMatch = brandText.match(/by\s+([A-Za-z\s&]+)\s+Product/i);
        const brand = brandMatch ? brandMatch[1].trim() : null;
        
        // Extract price
        const priceText = document.body.textContent;
        const priceMatches = priceText.match(/£([\d,]+\.?\d*)/g);
        const price = priceMatches && priceMatches.length > 0 ? priceMatches[0] : null;
        
        // Extract VAT price
        const vatMatch = priceText.match(/ex\.\s*VAT\s*£([\d,]+\.?\d*)/i);
        const priceExVAT = vatMatch ? `£${vatMatch[1]}` : null;
        
        // Extract reviews
        const reviewMatch = priceText.match(/\(\s*(\d+)\s*\)/);
        const reviews = reviewMatch ? parseInt(reviewMatch[1]) : 0;
        
        // Extract rating
        const ratingElement = document.querySelector('[class*="rating"]');
        const rating = ratingElement ? ratingElement.textContent.trim() : null;
        
        // Extract images
        const images = Array.from(document.querySelectorAll('img'))
          .map(img => img.src || img.getAttribute('data-src'))
          .filter(src => src && (src.includes('toolstation') || src.includes('product') || src.includes('media')))
          .filter(src => !src.includes('logo') && !src.includes('icon'))
          .slice(0, 5);
        
        // Extract availability
        const availabilityText = document.body.textContent;
        const inStock = !availabilityText.includes('Out of stock');
        
        // Extract description
        const description = document.querySelector('[class*="description"]')?.textContent?.trim() || null;
        
        return {
          productCode: code,
          title,
          brand,
          price,
          priceExVAT,
          rating,
          reviews,
          images,
          inStock,
          description,
          url: window.location.href
        };
      }, productCode);
      
      await browserPage.close();
      
      return product;
      
    } catch (error) {
      await browserPage.close();
      throw new Error(`Product fetch failed: ${error.message}`);
    }
  }
}

module.exports = ToolStationScraper;
