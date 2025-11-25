# BigQuery - GAS - Lib (Google Apps Script BigQuery Service)

This library provides a robust, centralized class (`BigQueryService`) for managing all interactions between **Google Apps Script (GAS)** and **Google BigQuery**. It handles queries, asynchronous job management, large CSV data uploads, caching, and table management.

## Prerequisites and Setup

To use this library, **three key components** must be configured in your Apps Script project.

### 1. Enable BigQuery Advanced Service

The core of this library relies on Google's Advanced Services for table creation and retrieving dataset locations.

1.  Open your Apps Script project.
2.  In the left sidebar, find **Services**.
3.  Scroll down, select **BigQuery API**, and click **Add**.
4.  Ensure the corresponding **BigQuery API** is enabled in your associated Google Cloud Project (GCP) dashboard.

### 2. Install OAuth2 for Apps Script Library

Authentication uses a service account, which is managed via the external OAuth2 library.

1.  In your Apps Script project, go to **Libraries** (left sidebar).
2.  Add the script ID: `1B7FS40VDpXF_LgJyHpfFtS-oW4HCh_VKXcoo6kD84P92i6D-Aq_Tny_`
3.  Set the identifier to **`OAuth2`**.

### 3. Configure Service Account Credentials (Script Properties)

The library's `SuperOAuth2` class retrieves the service account credentials from the **Script Properties**.

1.  Obtain your service account credentials (Client Email and Private Key) from GCP.
2.  In your Apps Script project, go to **Project settings** (the gear icon).
3.  Scroll down to **Script properties**.
4.  Add the following two properties (Keys are **case-sensitive**):

| Key | Value | Notes |
| :--- | :--- | :--- |
| **`clientEmail`** | `your-service-account@project-id.iam.gserviceaccount.com` | The email address of your service account. |
| **`privateKey`** | `-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n` | The entire private key, including headers, with **actual newline characters escaped to `\n`**. |

## Usage Overview

Once configured, the main entry point for data export is the `pushSheetDataToBQ` helper function, or you can directly call methods from the static `BigQueryService` class.

```javascript
// Example of pushing data using the helper function
function exportTransactions() {
    // Note: BQConfig, BQSchema, and getSheetDataAsObjects must be defined.
    const sheetName = "Transactions";
    const tableId = BQConfig.TableIdYourtime;
    
    pushSheetDataToBQ(
        sheetName, 
        tableId, 
        BQSchema.SchemaFieldsTransaction, 
        BQSchema.HeadersTransaction
    );
}

// Example of querying the database
function fetchRecentData() {
    const service = SuperOAuth2.getBQOAuthService();
    const query = "SELECT * FROM `project.dataset.table` LIMIT 100";
    
    const results = BigQueryService.runQuery(query, service, BQConfig.ProjectId);
    
    Logger.log("Fetched %s rows.", results.length);
}
