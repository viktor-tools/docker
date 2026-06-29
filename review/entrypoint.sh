#!/bin/sh

# --- Configuration via Environment Variables ---

# API URL (with a default for prod if not specified)
API_URL="${VIKTOR_API_URL:-https://api.viktor.tools}"

# Checking mandatory variables
if [ -z "$VIKTOR_APP_ID" ]; then
    echo "ERROR: The VIKTOR_APP_ID environment variable must be defined."
    exit 1
fi

if [ -z "$VIKTOR_APP_SECRET" ]; then
    echo "ERROR: The VIKTOR_APP_SECRET environment variable must be defined."
    exit 1
fi

if [ -z "$CI_MERGE_REQUEST_IID" ] && [ -z "$GITHUB_PR_ID" ]; then
    echo "ERROR: Either CI_MERGE_REQUEST_IID (GitLab) or GITHUB_PR_ID (GitHub) environment variable must be defined (Job launched outside MR/PR?)."
    exit 1
fi

# Determine the merge request/pull request ID
if [ -n "$CI_MERGE_REQUEST_IID" ]; then
    MERGE_REQUEST_ID="$CI_MERGE_REQUEST_IID"
elif [ -n "$GITHUB_PR_ID" ]; then
    MERGE_REQUEST_ID="$GITHUB_PR_ID"
fi


# --- 1. Execute API call ---

echo "Starting Viktor review for MR/PR #$MERGE_REQUEST_ID on application $VIKTOR_APP_ID..."

RESPONSE=$(curl -s -w "\n%{http_code}\n%{time_total}" \
    --request POST \
    --header "Content-Type: application/json" \
    --header "X-APP-ID: $VIKTOR_APP_ID" \
    --header "X-APP-SECRET: $VIKTOR_APP_SECRET" \
    --data "{ \"mergeRequestId\": \"$MERGE_REQUEST_ID\" }" \
    "$API_URL/semantic-analyze")

# --- 2. Processing and Displaying Results ---

BODY=$(echo "$RESPONSE" | sed -n '1p')
STATUS=$(echo "$RESPONSE" | sed -n '2p')
TIME=$(echo "$RESPONSE" | sed -n '3p')
TIME_MS=$(echo "$TIME * 1000" | bc | cut -d'.' -f1)
TOKENS=$(echo "$BODY" | jq -r '.tokensUsed // 0')

echo "--- Results ---"
echo "Response in $TIME_MS ms - $TOKENS token(s) used"

if [ "$STATUS" -eq 200 ]; then
    MESSAGE=$(echo "$BODY" | jq -r '.message')
    echo "✅ OK: $MESSAGE"
    exit 0
elif [ "$STATUS" -eq 204 ]; then
    echo "⚠️ SKIPPED"
    exit 0 # Success (skipped)
else
    ERROR_MESSAGE=$(echo "$BODY" | jq -r '.message')
    echo "❌ Review failed (Status $STATUS): $ERROR_MESSAGE"
    # Adding error detail for debugging
    # echo "Full response body: $BODY"
    exit 1 # Job failure
fi