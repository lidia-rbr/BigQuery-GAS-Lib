/**
 * SuperBQ Library
 * * A functional library for managing BigQuery interactions within Google Apps Script.
 * * DEPENDENCIES:
 * 1. Library: "OAuth2" (ID: 1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF)
 * 2. Service: "BigQuery API" (Add via Services +)
 * 3. Script Properties: 'clientEmail' and 'privateKey' must be set.
 */

// ============================================================================
// 1. CONFIGURATION & SCHEMAS
// ============================================================================

/**
 * Global Configuration for BigQuery access.
 * Edit these values with your actual GCP details.
 */
const BQ_CONFIG = {
  projectId: 'your-gcp-project-id-123456',
  datasetId: 'analytics_data_set',
  // Map your table IDs here
  tables: {
    main: 'myTableId',
    products: 'product_inventory',
    transactions: 'transactions'
  }
};

/**
 * Standard Headers and Schema definitions.
 */
const BQ_SCHEMAS = {
  productInventory: {
    headers: [
      'productId',
      'productName',
      'category',
      'stockLevel',
      'price'
    ],
    fields: [
      { name: 'productId', type: 'STRING', mode: 'REQUIRED' },
      { name: 'productName', type: 'STRING', mode: 'NULLABLE' },
      { name: 'category', type: 'STRING', mode: 'NULLABLE' },
      { name: 'stockLevel', type: 'INTEGER', mode: 'NULLABLE' },
      { name: 'price', type: 'BIGNUMERIC', mode: 'NULLABLE' }
    ]
  }
};

// ============================================================================
// 2. AUTHENTICATION (OAuth2)
// ============================================================================

/**
 * Creates and returns a configured OAuth2 service for BigQuery.
 * Requires 'clientEmail' and 'privateKey' in Script Properties.
 * * @returns {Object} Configured OAuth2 service object.
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
 *
 * @param {string} query - SQL query to execute.
 * @param {Object} [oauthService] - Optional. Will create new service if not provided.
 * @param {string} [gcpProject] - Optional. Defaults to BQ_CONFIG.projectId.
 * @param {number} [cacheExpirationMinutes=300] - Cache duration.
 * @returns {Object[]} Result rows.
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

/**
 * Executes a query and returns a detailed status object (Job ID, Completion, Error).
 * Useful for DELETE/UPDATE/INSERT operations where row return isn't the priority.
 * * @param {string} query - SQL Query.
 * @param {Object} [oauthService] - Auth Service.
 * @returns {Object} { jobId, jobComplete, rows, error }
 */
function runQueryWithFeedback(query, oauthService = getBQOAuthService()) {
  const gcpProject = BQ_CONFIG.projectId;
  const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${gcpProject}/queries`;

  if (!oauthService.hasAccess()) {
    return { jobId: null, jobComplete: false, rows: [], error: "Auth failed" };
  }

  try {
    const response = UrlFetchApp.fetch(url, {
      method: "post",
      headers: { Authorization: `Bearer ${oauthService.getAccessToken()}` },
      contentType: "application/json",
      payload: JSON.stringify({ query: query, useLegacySql: false }),
      muteHttpExceptions: true
    });

    const responseData = JSON.parse(response.getContentText());
    
    // If immediate result
    if (responseData.jobComplete) {
      const rows = responseData.rows ? _parseBigQueryResponse(responseData) : [];
      return { jobId: responseData.jobReference?.jobId, jobComplete: true, rows: rows, error: null };
    }

    // If async, wait strictly for completion
    const jobId = responseData.jobReference?.jobId;
    const jobResult = _waitForJobCompletion(gcpProject, jobId, oauthService);
    
    const isSuccess = jobResult.status?.state === 'DONE' && !jobResult.status?.errorResult;
    const rows = jobResult.rows ? _parseBigQueryResponse(jobResult) : [];

    return { 
      jobId: jobId, 
      jobComplete: isSuccess, 
      rows: rows, 
      error: jobResult.status?.errorResult?.message || null 
    };

  } catch (e) {
    return { jobId: null, jobComplete: false, rows: [], error: e.message };
  }
}

/**
 * Loads data from an Array of Objects into BigQuery via CSV Load Job.
 * * @param {Object[]} dataObjects - Array of data objects.
 * @param {string} tableId - Target Table ID.
 * @param {string[]} headers - Ordered list of column names (must match schema).
 * @param {Object[]} schemaFields - Schema field definitions.
 * @param {string} [writeDisposition] - 'WRITE_APPEND' (default) or 'WRITE_TRUNCATE'.
 */
function loadCsvToBigQuery(dataObjects, tableId, headers, schemaFields, writeDisposition = "WRITE_APPEND") {
  const oauthService = getBQOAuthService();
  const datasetId = BQ_CONFIG.datasetId;
  const projectId = BQ_CONFIG.projectId;

  if (!oauthService.hasAccess()) throw new Error("Auth failed");
  console.log(`Loading ${dataObjects.length} rows into ${datasetId}.${tableId}`);

  // 1. Convert to CSV
  const csvString = [
    headers.join(";"),
    ...dataObjects.map(obj => 
      headers.map(h => {
        let val = obj[h] ?? "";
        val = String(val).replace(/[\r\n]+/g, " ").replace(/"/g, '""');
        return `"${val}"`;
      }).join(";")
    )
  ].join("\n");

  // 2. Prepare Job Config
  const jobConfig = {
    configuration: {
      load: {
        destinationTable: { projectId, datasetId, tableId },
        sourceFormat: "CSV",
        fieldDelimiter: ";",
        skipLeadingRows: 1,
        writeDisposition: writeDisposition,
        schema: { fields: schemaFields }
      }
    }
  };

  // 3. Upload (Multipart)
  const boundary = "b_boundary";
  const body = `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(jobConfig) + `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n` +
    csvString + `\r\n` +
    `--${boundary}--`;

  const response = UrlFetchApp.fetch(`https://www.googleapis.com/upload/bigquery/v2/projects/${projectId}/jobs?uploadType=multipart`, {
    method: "post",
    contentType: `multipart/related; boundary=${boundary}`,
    headers: { Authorization: `Bearer ${oauthService.getAccessToken()}` },
    payload: body,
    muteHttpExceptions: true
  });

  const result = JSON.parse(response.getContentText());
  if (result.error) throw new Error(result.error.message);
  
  const jobId = result.jobReference.jobId;
  console.log(`Load Job Submitted: ${jobId}`);

  // 4. Wait for completion
  const completion = _waitForJobCompletion(projectId, jobId, oauthService, 5000, 180000, { dataset: datasetId });
  
  if (completion.status?.errorResult) {
    throw new Error(`Load Failed: ${completion.status.errorResult.message}`);
  }
  return completion;
}

/**
 * Creates a table using the BigQuery Advanced Service.
 */
function createBigQueryTable(tableId, schemaFields) {
  if (typeof BigQuery === 'undefined') throw new Error("BigQuery Advanced Service not enabled.");

  const resource = {
    tableReference: { projectId: BQ_CONFIG.projectId, datasetId: BQ_CONFIG.datasetId, tableId },
    schema: { fields: schemaFields }
  };

  try {
    const table = BigQuery.Tables.insert(resource, BQ_CONFIG.projectId, BQ_CONFIG.datasetId);
    console.log(`Table ${tableId} created.`);
    return table;
  } catch (e) {
    if (e.toString().includes('Already Exists')) {
      console.log(`Table ${tableId} already exists.`);
      return null;
    }
    throw e;
  }
}

/**
 * Clears a table (DELETE WHERE TRUE).
 */
function clearBigQueryTable(tableId) {
  const query = `DELETE FROM \`${BQ_CONFIG.projectId}.${BQ_CONFIG.datasetId}.${tableId}\` WHERE TRUE;`;
  console.log(`Clearing ${tableId}...`);
  
  const result = runQueryWithFeedback(query);
  if (result.error) throw new Error(`Error clearing table: ${result.error}`);
  console.log(`Table ${tableId} cleared.`);
  return true;
}

// ============================================================================
// 4. INTERNAL HELPER FUNCTIONS
// ============================================================================

const _MAX_CACHE_SIZE = 100 * 1024;

/**
 * Internal: Chunked Cache Storage.
 */
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

/**
 * Internal: Chunked Cache Retrieval.
 */
function _retrieveFromCache(key) {
  const cache = CacheService.getScriptCache();
  const countStr = cache.get(`${key}_count`);

  if (countStr) {
    let full = '';
    const count = parseInt(countStr, 10);
    for (let i = 0; i < count; i++) {
      const chunk = cache.get(`${key}_p${i}`);
      if (!chunk) return null; // Broken chain
      full += chunk;
    }
    return full;
  }
  return cache.get(key);
}

/**
 * Internal: Wait loop for async jobs.
 */
function _waitForJobCompletion(projectId, jobId, oauthService, interval = 2000, maxWait = 180000, opts = {}) {
  const start = Date.now();
  // Attempt to guess location from config if not provided, needed for some job lookups
  const location = opts.location || (typeof BigQuery !== 'undefined' ? BigQuery.Datasets.get(projectId, BQ_CONFIG.datasetId).location : null);
  
  while (Date.now() - start < maxWait) {
    const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/jobs/${jobId}` + 
                (location ? `?location=${location}` : '');
    
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: `Bearer ${oauthService.getAccessToken()}` },
      muteHttpExceptions: true
    });
    
    if (resp.getResponseCode() === 200) {
      const job = JSON.parse(resp.getContentText());
      if (job.status.state === 'DONE') return job;
    }
    
    Utilities.sleep(interval);
  }
  throw new Error("Timeout waiting for Job " + jobId);
}

/**
 * Internal: Convert BQ JSON response to Array of Objects.
 */
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