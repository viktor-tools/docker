#!/bin/sh

# --- Configuration via Environment Variables ---

API_URL="${VIKTOR_API_URL:-https://api.viktor.tools}"
BASE_BRANCH="${BASE_BRANCH:-main}"

if [ -z "$VIKTOR_APP_ID" ]; then
    echo "ERROR: The VIKTOR_APP_ID environment variable must be defined."
    exit 1
fi

if [ -z "$VIKTOR_APP_SECRET" ]; then
    echo "ERROR: The VIKTOR_APP_SECRET environment variable must be defined."
    exit 1
fi

if [ -z "$REPO_URL" ]; then
    echo "ERROR: The REPO_URL environment variable must be defined."
    exit 1
fi

if [ -z "$BRANCH" ]; then
    echo "ERROR: The BRANCH environment variable must be defined."
    exit 1
fi

if [ -z "$VCS_TOKEN" ]; then
    echo "ERROR: The VCS_TOKEN environment variable must be defined."
    exit 1
fi

# --- 1. Clone the repository ---

echo "Cloning repository on branch '$BRANCH'..."

REPO_WITH_TOKEN=$(echo "$REPO_URL" | sed "s|://|://$VCS_TOKEN@|")

git clone --depth=50 --branch "$BRANCH" "$REPO_WITH_TOKEN" /repo 2>&1
CLONE_EXIT=$?

if [ $CLONE_EXIT -ne 0 ]; then
    echo "ERROR: Failed to clone repository. Check VCS_TOKEN permissions and REPO_URL."
    RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
        --request POST \
        --header "Content-Type: application/json" \
        --header "X-APP-ID: $VIKTOR_APP_ID" \
        --header "X-APP-SECRET: $VIKTOR_APP_SECRET" \
        --data "{ \"error\": \"CLONE_FAILED\", \"branch\": \"$BRANCH\" }" \
        "$API_URL/semantic-analyze/mcp/error" 2>/dev/null || true)
    exit 1
fi

echo "Clone successful."

# --- 2. Generate diff against base branch ---

cd /repo

git fetch origin "$BASE_BRANCH" 2>&1

echo "Generating diff between '$BASE_BRANCH' and '$BRANCH'..."

CODE_DIFF=$(git diff "origin/$BASE_BRANCH"...HEAD 2>&1)

if [ -z "$CODE_DIFF" ]; then
    echo "ERROR: No diff found between '$BASE_BRANCH' and '$BRANCH'. Nothing to analyze."
    exit 1
fi

DIFF_SIZE=${#CODE_DIFF}
echo "Diff size: $DIFF_SIZE characters"

# --- 3. Initiate review session ---

echo "Initiating Viktor Deep analysis for branch '$BRANCH' on application $VIKTOR_APP_ID..."

INIT_RESPONSE=$(curl -s \
    --request POST \
    --header "Content-Type: application/json" \
    --header "X-APP-ID: $VIKTOR_APP_ID" \
    --header "X-APP-SECRET: $VIKTOR_APP_SECRET" \
    --data "{ \"branch\": \"$BRANCH\", \"mode\": \"DEEP\" }" \
    "$API_URL/semantic-analyze/mcp/init")

REVIEW_ID=$(echo "$INIT_RESPONSE" | jq -r '.reviewId // empty')
UPLOAD_URL=$(echo "$INIT_RESPONSE" | jq -r '.uploadUrl // empty')
FINALIZE_URL=$(echo "$INIT_RESPONSE" | jq -r '.finalizeUrl // empty')
CANCEL_URL=$(echo "$INIT_RESPONSE" | jq -r '.cancelUrl // empty')
CHUNK_MAX_SIZE=$(echo "$INIT_RESPONSE" | jq -r '.chunkMaxSize // 51200')

if [ -z "$REVIEW_ID" ]; then
    echo "ERROR: Failed to initiate review session. API response: $INIT_RESPONSE"
    exit 1
fi

echo "Review session started: $REVIEW_ID"

# --- 4. Upload diff in chunks ---

TOTAL_CHARS=${#CODE_DIFF}
CHUNK_INDEX=1
OFFSET=0
TOTAL_CHUNKS=$(( (TOTAL_CHARS + CHUNK_MAX_SIZE - 1) / CHUNK_MAX_SIZE ))

echo "Uploading $TOTAL_CHUNKS chunk(s)..."

while [ $OFFSET -lt $TOTAL_CHARS ]; do
    CHUNK=$(echo "$CODE_DIFF" | cut -c$((OFFSET + 1))-$((OFFSET + CHUNK_MAX_SIZE)))

    CHUNK_JSON=$(jq -n \
        --argjson idx "$CHUNK_INDEX" \
        --arg data "$CHUNK" \
        --argjson total "$TOTAL_CHUNKS" \
        '{"chunkIndex": $idx, "chunkData": $data, "totalChunks": $total}')

    UPLOAD_RESPONSE=$(curl -s -w "\n%{http_code}" \
        --request POST \
        --header "Content-Type: application/json" \
        --header "X-APP-ID: $VIKTOR_APP_ID" \
        --header "X-APP-SECRET: $VIKTOR_APP_SECRET" \
        --data "$CHUNK_JSON" \
        "$UPLOAD_URL")

    UPLOAD_BODY=$(echo "$UPLOAD_RESPONSE" | sed -n '1p')
    UPLOAD_STATUS=$(echo "$UPLOAD_RESPONSE" | sed -n '2p')

    if [ "$UPLOAD_STATUS" != "200" ]; then
        echo "ERROR: Failed to upload chunk $CHUNK_INDEX (HTTP $UPLOAD_STATUS): $UPLOAD_BODY"
        curl -s -o /dev/null \
            --request POST \
            --header "Content-Type: application/json" \
            --header "X-APP-ID: $VIKTOR_APP_ID" \
            --header "X-APP-SECRET: $VIKTOR_APP_SECRET" \
            "$CANCEL_URL" || true
        exit 1
    fi

    echo "Chunk $CHUNK_INDEX/$TOTAL_CHUNKS uploaded."

    OFFSET=$((OFFSET + CHUNK_MAX_SIZE))
    CHUNK_INDEX=$((CHUNK_INDEX + 1))
done

# --- 5. Finalize review ---

echo "Finalizing analysis..."

FINAL_RESPONSE=$(curl -s -w "\n%{http_code}\n%{time_total}" \
    --request POST \
    --header "Content-Type: application/json" \
    --header "X-APP-ID: $VIKTOR_APP_ID" \
    --header "X-APP-SECRET: $VIKTOR_APP_SECRET" \
    "$FINALIZE_URL")

FINAL_BODY=$(echo "$FINAL_RESPONSE" | sed -n '1p')
FINAL_STATUS=$(echo "$FINAL_RESPONSE" | sed -n '2p')
FINAL_TIME=$(echo "$FINAL_RESPONSE" | sed -n '3p')
FINAL_TIME_MS=$(echo "$FINAL_TIME * 1000" | bc | cut -d'.' -f1)
TOKENS=$(echo "$FINAL_BODY" | jq -r '.tokensUsed // 0')

echo "--- Results ---"
echo "Response in ${FINAL_TIME_MS}ms - $TOKENS token(s) used"

if [ "$FINAL_STATUS" -eq 200 ]; then
    MESSAGE=$(echo "$FINAL_BODY" | jq -r '.message // "Analysis complete."')
    echo "OK: $MESSAGE"
    exit 0
elif [ "$FINAL_STATUS" -eq 204 ]; then
    echo "SKIPPED: No issue ID found in branch name or analysis not required."
    exit 0
else
    ERROR_MESSAGE=$(echo "$FINAL_BODY" | jq -r '.message // "Unknown error"')
    echo "Deep analysis failed (HTTP $FINAL_STATUS): $ERROR_MESSAGE"
    exit 1
fi
