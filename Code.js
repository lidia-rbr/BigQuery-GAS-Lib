
/**
 * BigQueryManager - BigQuery Library for Google Apps Script.
 *
 * Features:
 * - Automatic user / service account authentication
 * - BigQuery Standard SQL execution
 * - Long-running query polling
 * - Automatic result pagination
 * - Optional query result caching
 * - HTTP and query error handling
 *
 * DEPENDENCIES:
 * OAuth2 library (only for service account authentication):
 * 1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF
 *
 * OPTIONAL SCRIPT PROPERTIES:
 * - clientEmail
 * - privateKey
 *
 * Without these properties, the executing Google account is used.
 */

// ============================================================================
// 1. CONFIGURATION
// ============================================================================

const BQ_CONFIG = {
  projectId: 'your-gcp-project-id-123456',
  datasetId: 'analytics_data_set'
};

const BQ_CACHE_CONFIG = {
  chunkSize: 90000,
  maxParts: 10,
  maxExpirationSeconds: 21600
};

// ============================================================================
// 2. AUTHENTICATION
// ============================================================================

/**
 * Returns the authentication service for BigQuery.
 *
 * Uses a service account when both credentials are configured.
 * Otherwise, uses the executing user's Google account.
 *
 * @returns {Object} Authentication service.
 */
function getBQOAuthService() {
  const scriptProps = PropertiesService.getScriptProperties();

  const clientEmail = scriptProps.getProperty('clientEmail');
  const privateKeyRaw = scriptProps.getProperty('privateKey');

  // Use current user when no service account is configured.
  if (!clientEmail && !privateKeyRaw) {
    console.log('BigQuery authentication: current user');

    return {
      hasAccess: () => true,
      getAccessToken: () => ScriptApp.getOAuthToken(),
      getLastError: () => null
    };
  }

  // Prevent incomplete configuration.
  if (!clientEmail || !privateKeyRaw) {
    throw new Error(
      'Incomplete BigQuery service account configuration. ' +
      'Provide both clientEmail and privateKey, or neither.'
    );
  }

  console.log('BigQuery authentication: service account');

  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

  return OAuth2.createService('BQ')
    .setTokenUrl('https://oauth2.googleapis.com/token')
    .setPrivateKey(privateKey)
    .setIssuer(clientEmail)
    .setPropertyStore(scriptProps)
    .setScope('https://www.googleapis.com/auth/bigquery');
}

// ============================================================================
// 3. CORE BIGQUERY FUNCTION
// ============================================================================

/**
 * Executes a BigQuery query and returns all result pages.
 *
 * Automatically waits for long-running queries and optionally
 * caches simple SELECT queries.
 *
 * Cache is disabled when cacheExpirationMinutes is 0.
 *
 * @param {string} query Standard SQL query.
 * @param {Object} oauthService Authentication service.
 * @param {string} gcpProject Google Cloud project ID.
 * @param {number} cacheExpirationMinutes Cache duration in minutes.
 * @returns {Array<Object>} Query results.
 */
function runBigQuery(
  query,
  oauthService = getBQOAuthService(),
  gcpProject = BQ_CONFIG.projectId,
  cacheExpirationMinutes = 300
) {
  if (!oauthService.hasAccess()) {
    throw new Error(
      'BigQuery authorization error: ' +
      oauthService.getLastError()
    );
  }

  const accessToken = oauthService.getAccessToken();

  const headers = {
    Authorization: `Bearer ${accessToken}`
  };

  // Cache only simple SELECT statements.
  const useCache =
    cacheExpirationMinutes > 0 &&
    /^\s*SELECT\b/i.test(query);

  let cacheKey = null;

  // 1. Check cache.
  if (useCache) {
    cacheKey = _getBQCacheKey(
      query,
      gcpProject,
      accessToken
    );

    const cachedData = _retrieveFromCache(cacheKey);

    if (cachedData !== null) {
      console.log('BigQuery results retrieved from cache.');
      return JSON.parse(cachedData);
    }
  }

  const url =
    `https://bigquery.googleapis.com/bigquery/v2/projects/` +
    `${encodeURIComponent(gcpProject)}/queries`;

  try {
    // 2. Execute query.
    const responseData = _fetchBQJson(url, {
      method: 'post',
      headers,
      contentType: 'application/json',
      payload: JSON.stringify({
        query,
        useLegacySql: false
      })
    });

    const jobId = responseData.jobReference?.jobId;
    const location = responseData.jobReference?.location;

    let result = responseData;

    // 3. Wait if query is still running.
    if (!result.jobComplete) {
      if (!jobId) {
        throw new Error(
          'BigQuery returned an incomplete query without a job ID.'
        );
      }

      console.log(`Waiting for BigQuery job: ${jobId}`);

      result = _waitForJobCompletion(
        gcpProject,
        jobId,
        oauthService,
        2000,
        180000,
        { location }
      );
    }

    // 4. Validate completed query.
    _checkBQQueryErrors(result);

    // 5. Parse first result page.
    let finalData = _parseBigQueryResponse(result);
    let pageToken = result.pageToken || null;

    // 6. Retrieve additional pages.
    while (pageToken) {
      if (!jobId) {
        throw new Error(
          'Cannot retrieve additional pages without a job ID.'
        );
      }

      const params = [
        `pageToken=${encodeURIComponent(pageToken)}`
      ];

      if (location) {
        params.push(
          `location=${encodeURIComponent(location)}`
        );
      }

      const paginatedUrl =
        `https://bigquery.googleapis.com/bigquery/v2/projects/` +
        `${encodeURIComponent(gcpProject)}/queries/` +
        `${encodeURIComponent(jobId)}?${params.join('&')}`;

      const pageData = _fetchBQJson(paginatedUrl, {
        method: 'get',
        headers
      });

      if (!pageData.jobComplete) {
        throw new Error(
          `BigQuery result page is not ready: ${jobId}`
        );
      }

      _checkBQQueryErrors(pageData);

      finalData = finalData.concat(
        _parseBigQueryResponse({
          ...pageData,
          schema: pageData.schema || result.schema
        })
      );

      pageToken = pageData.pageToken || null;
    }

    // 7. Cache complete results.
    if (useCache) {
      _storeInCache(
        cacheKey,
        JSON.stringify(finalData),
        cacheExpirationMinutes
      );
    }

    console.log(
      `BigQuery query completed: ${finalData.length} rows.`
    );

    return finalData;

  } catch (error) {
    console.error('BigQuery execution error:', error);
    throw error;
  }
}

// ============================================================================
// 4. BIGQUERY HELPERS
// ============================================================================

/**
 * Executes a BigQuery REST request and validates HTTP status.
 *
 * @param {string} url BigQuery API endpoint.
 * @param {Object} options UrlFetchApp request options.
 * @returns {Object} Parsed JSON response.
 */
function _fetchBQJson(url, options) {
  const response = UrlFetchApp.fetch(url, {
    ...options,
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const body = response.getContentText();

  if (status < 200 || status >= 300) {
    let message = body;

    try {
      const errorData = JSON.parse(body);
      message = errorData.error?.message || body;
    } catch (error) {
      // Keep original response body.
    }

    throw new Error(
      `BigQuery API error (${status}): ${message}`
    );
  }

  return JSON.parse(body);
}

/**
 * Validates errors returned by a BigQuery query response.
 *
 * @param {Object} response BigQuery query response.
 * @returns {void}
 */
function _checkBQQueryErrors(response) {
  if (response.jobComplete && response.errors?.length) {
    const message = response.errors
      .map(error => error.message || error.reason)
      .join('; ');

    throw new Error(`BigQuery query error: ${message}`);
  }
}

/**
 * Waits for a BigQuery job and retrieves its first result page.
 *
 * Uses jobs.getQueryResults instead of jobs.get.
 *
 * @param {string} projectId Google Cloud project ID.
 * @param {string} jobId BigQuery job ID.
 * @param {Object} oauthService Authentication service.
 * @param {number} interval Polling interval in milliseconds.
 * @param {number} maxWait Maximum waiting time in milliseconds.
 * @param {Object} opts Additional configuration.
 * @returns {Object} Completed query results response.
 */
function _waitForJobCompletion(
  projectId,
  jobId,
  oauthService,
  interval = 2000,
  maxWait = 180000,
  opts = {}
) {
  const start = Date.now();

  const params = ['timeoutMs=1000'];

  if (opts.location) {
    params.push(
      `location=${encodeURIComponent(opts.location)}`
    );
  }

  const url =
    `https://bigquery.googleapis.com/bigquery/v2/projects/` +
    `${encodeURIComponent(projectId)}/queries/` +
    `${encodeURIComponent(jobId)}?${params.join('&')}`;

  while (Date.now() - start < maxWait) {
    const result = _fetchBQJson(url, {
      method: 'get',
      headers: {
        Authorization: `Bearer ${oauthService.getAccessToken()}`
      }
    });

    if (result.jobComplete) {
      return result;
    }

    Utilities.sleep(interval);
  }

  throw new Error(
    `Timeout waiting for BigQuery job ${jobId}.`
  );
}

/**
 * Converts BigQuery REST result rows into objects.
 *
 * Uses the top-level schema to map column names.
 * Nested and repeated values remain in their REST representation.
 *
 * @param {Object} data BigQuery response.
 * @returns {Array<Object>} Parsed rows.
 */
function _parseBigQueryResponse(data) {
  if (!data.rows || data.rows.length === 0) {
    return [];
  }

  if (!data.schema?.fields) {
    throw new Error(
      'BigQuery returned rows without a schema.'
    );
  }

  const headers = data.schema.fields.map(
    field => field.name
  );

  return data.rows.map(row => {
    const obj = {};

    row.f.forEach((cell, index) => {
      obj[headers[index]] = cell.v;
    });

    return obj;
  });
}

// ============================================================================
// 5. CACHE HELPERS
// ============================================================================

/**
 * Generates a cache key from query, project and access token.
 *
 * The token hash isolates cached data between credentials.
 * Token refreshes can reduce cache reuse.
 *
 * @param {string} query SQL query.
 * @param {string} projectId Google Cloud project ID.
 * @param {string} accessToken OAuth2 token.
 * @returns {string} Cache key.
 */
function _getBQCacheKey(query, projectId, accessToken) {
  const input = JSON.stringify({
    query,
    projectId,
    accessToken
  });

  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    input
  );

  return `bq_v2_${_convertByteArrayToHex(digest)}`;
}

/**
 * Stores UTF-8 data as Base64 chunks in user cache.
 *
 * CacheService supports a maximum of 100 KB per entry
 * and a maximum expiration of 21600 seconds.
 *
 * @param {string} key Cache identifier.
 * @param {string} data Data to store.
 * @param {number} minutes Expiration in minutes.
 * @returns {boolean} Whether data was cached.
 */
function _storeInCache(key, data, minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return false;
  }

  const cache = CacheService.getUserCache();

  const seconds = Math.min(
    BQ_CACHE_CONFIG.maxExpirationSeconds,
    Math.max(1, Math.floor(minutes * 60))
  );

  const encoded = Utilities.base64Encode(
    data,
    Utilities.Charset.UTF_8
  );

  const chunkSize = BQ_CACHE_CONFIG.chunkSize;
  const parts = Math.ceil(encoded.length / chunkSize);

  if (parts > BQ_CACHE_CONFIG.maxParts) {
    console.log(
      'BigQuery result too large for cache. Skipping.'
    );
    return false;
  }

  // Store data first.
  for (let i = 0; i < parts; i++) {
    const chunk = encoded.substring(
      i * chunkSize,
      (i + 1) * chunkSize
    );

    cache.put(`${key}_p${i}`, chunk, seconds);
  }

  // Write manifest last.
  cache.put(`${key}_count`, String(parts), seconds);

  return true;
}

/**
 * Retrieves and reconstructs cached data.
 *
 * @param {string} key Cache identifier.
 * @returns {?string} Cached data or null.
 */
function _retrieveFromCache(key) {
  const cache = CacheService.getUserCache();
  const countStr = cache.get(`${key}_count`);

  if (!countStr) {
    return null;
  }

  const count = Number(countStr);

  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > BQ_CACHE_CONFIG.maxParts
  ) {
    return null;
  }

  let encoded = '';

  for (let i = 0; i < count; i++) {
    const chunk = cache.get(`${key}_p${i}`);

    if (chunk === null) {
      return null;
    }

    encoded += chunk;
  }

  try {
    const bytes = Utilities.base64Decode(encoded);

    return Utilities.newBlob(bytes)
      .getDataAsString('UTF-8');

  } catch (error) {
    console.warn('Invalid BigQuery cache entry:', error);
    return null;
  }
}

/**
 * Converts a byte array to hexadecimal.
 *
 * @param {Array<number>} byteArray Input bytes.
 * @returns {string} Hexadecimal string.
 */
function _convertByteArrayToHex(byteArray) {
  return byteArray
    .map(byte =>
      ('0' + (byte & 0xFF).toString(16)).slice(-2)
    )
    .join('');
}
