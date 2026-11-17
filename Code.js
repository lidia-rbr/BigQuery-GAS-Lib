/**
 * BQ Library
 * * A functional library for managing BigQuery interactions within Google Apps Script.
 * * DEPENDENCIES:
 * 1. Library: "OAuth2" (ID: 1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF)
 * 2. Service: "BigQuery API" (Add via Services +)
 * 3. Script Properties: 'clientEmail' and 'privateKey' must be set.
 */

// ============================================================================
// 1. CONFIGURATION
// ============================================================================

const BQ_CONFIG = {
  projectId: 'your-gcp-project-id-123456', // UPDATE THIS
  datasetId: 'analytics_data_set',          // UPDATE THIS
};

// ============================================================================
// 2. AUTHENTICATION (OAuth2)
// ============================================================================

/**
 * Creates and returns a configured OAuth2 service for BigQuery.
 * Requires 'clientEmail' and 'privateKey' in Script Properties.
 */
function getBQOAuthService() {
  const scriptProps = PropertiesService.getScriptProperties();
  const clientEmail = scriptProps.getProperty("clientEmail");
  const privateKeyRaw = scriptProps.getProperty("privateKey");

  if (!clientEmail) throw new Error("Property 'clientEmail' not found in Script Properties.");
  if (!privateKeyRaw) throw new Error("Property 'privateKey' not found in Script Properties.");

  // Format private key (handle escaped newlines)
  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

  try {
    return OAuth2.createService('BQ')
      .setTokenUrl('https://oauth2.googleapis.com/token')
      .setPrivateKey(privateKey)
      .setIssuer(clientEmail)
      .setPropertyStore(scriptProps)
      .setScope('https://www.googleapis.com/auth/bigquery');
  } catch (error) {
    console.error("Error creating OAuth2 service:", error);
    throw new Error("Failed to initialize BQ OAuth Service: " + error.message);
  }
}

// ============================================================================
// 3. CORE BIGQUERY FUNCTIONS
// ============================================================================

/**
 * Executes a BigQuery query (sync/async) and returns the results as an array of objects.
 * Handles caching automatically.
 */
function runBigQuery(query, oauthService = getBQOAuthService(), gcpProject = BQ_CONFIG.projectId, cacheExpirationMinutes = 300) {
  const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${gcpProject}/queries`;

  if (!oauthService.hasAccess()) {
    throw new Error("BigQuery authorization error: " + oauthService.getLastError());
  }

  // 1. Check Cache
  const queryHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, query);
  const cacheKey = `bq_cache_${_convertByteArrayToHex(queryHash)}`;
  const cachedData = _retrieveFromCache(cacheKey);

  if (cachedData) {
    console.log('Result retrieved from cache.');
    return JSON.parse(cachedData);
  }

  // 2. Execute Query
  const headers = { Authorization: `Bearer ${oauthService.getAccessToken()}` };
  const options = {
    method: "post",
    headers: headers,
    contentType: "application/json",
    payload: JSON.stringify({ query: query, useLegacySql: false }),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const responseData = JSON.parse(response.getContentText());
    
    let finalData = [];
    let pageToken = null;
    let jobId = responseData?.jobReference?.jobId;

    if (jobId && !responseData.jobComplete) {
      // Long running query
      console.log(`Job ID: ${jobId} - Waiting asynchronously...`);
      const jobData = _waitForJobCompletion(gcpProject, jobId, oauthService);
      
      if (jobData?.status?.errorResult) throw new Error(`Job failed: ${jobData.status.errorResult.message}`);
      
      if (jobData.rows) finalData = _parseBigQueryResponse(jobData);
      pageToken = jobData.pageToken;

      // Handle Pagination
      while (pageToken) {
        const paginatedUrl = `https://bigquery.googleapis.com/bigquery/v2/projects/${gcpProject}/queries/${jobId}?pageToken=${pageToken}`;
        const pResp = UrlFetchApp.fetch(paginatedUrl, { method: "get", headers, muteHttpExceptions: true });
        const pData = JSON.parse(pResp.getContentText());
        if (pData.rows) finalData = finalData.concat(_parseBigQueryResponse(pData));
        pageToken = pData.pageToken || null;
      }
    } else if (responseData.rows) {
      // Fast query
      finalData = _parseBigQueryResponse(responseData);
    }

    // 3. Store in Cache
    _storeInCache(cacheKey, JSON.stringify(finalData), cacheExpirationMinutes);
    return finalData;

  } catch (error) {
    console.error("Error executing BigQuery request:", error);
    throw error;
  }
}

// ============================================================================
// 4. INTERNAL HELPER FUNCTIONS
// ============================================================================

const _MAX_CACHE_SIZE = 100 * 1024;

function _storeInCache(key, data, minutes) {
  const cache = CacheService.getScriptCache();
  const seconds = minutes * 60;
  if (data.length > _MAX_CACHE_SIZE) {
    const parts = Math.ceil(data.length / _MAX_CACHE_SIZE);
    for (let i = 0; i < parts; i++) {
      const chunk = data.substring(i * _MAX_CACHE_SIZE, (i + 1) * _MAX_CACHE_SIZE);
      cache.put(`${key}_p${i}`, chunk, seconds);
    }
    cache.put(`${key}_count`, parts.toString(), seconds);
  } else {
    cache.put(key, data, seconds);
  }
}

function _retrieveFromCache(key) {
  const cache = CacheService.getScriptCache();
  const countStr = cache.get(`${key}_count`);
  if (countStr) {
    let full = '';
    const count = parseInt(countStr, 10);
    for (let i = 0; i < count; i++) {
      const chunk = cache.get(`${key}_p${i}`);
      if (!chunk) return null; 
      full += chunk;
    }
    return full;
  }
  return cache.get(key);
}

function _waitForJobCompletion(projectId, jobId, oauthService, interval = 2000, maxWait = 180000, opts = {}) {
  const start = Date.now();
  const location = opts.location || (
    typeof BigQuery !== 'undefined'
      ? BigQuery.Datasets.get(projectId, BQ_CONFIG.datasetId).location
      : null
  );

  const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/queries/${jobId}` +
    (location ? `?location=${encodeURIComponent(location)}` : '');

  while (Date.now() - start < maxWait) {
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        Authorization: `Bearer ${oauthService.getAccessToken()}`
      },
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) {
      throw new Error(`BigQuery error: ${response.getContentText()}`);
    }

    const data = JSON.parse(response.getContentText());

    if (data.jobComplete) {
      return data;
    }

    Utilities.sleep(interval);
  }

  throw new Error(`Timeout waiting for BigQuery job ${jobId}`);
}

function _parseBigQueryResponse(data) {
  if (!data.schema || !data.rows) return [];
  const headers = data.schema.fields.map(f => f.name);
  return data.rows.map(row => {
    const obj = {};
    row.f.forEach((cell, i) => {
      obj[headers[i]] = cell.v;
    });
    return obj;
  });
}

function _convertByteArrayToHex(byteArray) {
  return byteArray.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}
