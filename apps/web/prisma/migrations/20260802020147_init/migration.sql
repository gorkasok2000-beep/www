-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "handle" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "accountAddress" TEXT NOT NULL,
    "salt" TEXT NOT NULL DEFAULT '0',
    "ownerAddress" TEXT NOT NULL,
    "signerMode" TEXT NOT NULL DEFAULT 'SERVER_KEY',
    "ownerKeyCiphertext" TEXT,
    "signerUrl" TEXT,
    "custodianAddress" TEXT,
    "custodianKeyCiphertext" TEXT,
    "apiKeyHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "valueWei" TEXT NOT NULL,
    "data" TEXT NOT NULL DEFAULT '0x',
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "userOpHash" TEXT,
    "txHash" TEXT,
    "blockNumber" TEXT,
    "failureReason" TEXT,
    "invoiceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Payment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issuerAgentId" TEXT,
    "to" TEXT NOT NULL,
    "valueWei" TEXT NOT NULL,
    "memo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" DATETIME,
    CONSTRAINT "Invoice_issuerAgentId_fkey" FOREIGN KEY ("issuerAgentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SessionKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "privateKeyCiphertext" TEXT NOT NULL,
    "budgetWei" TEXT NOT NULL,
    "validUntil" DATETIME NOT NULL,
    "targets" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" DATETIME,
    "revokedAt" DATETIME,
    CONSTRAINT "SessionKey_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TransactionLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "accountAddress" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "valueWei" TEXT NOT NULL,
    "selector" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "blockNumber" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "logIndex" INTEGER NOT NULL,
    CONSTRAINT "TransactionLog_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IndexerState" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "lastBlockNumber" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "FaucetGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "valueWei" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FaucetGrant_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Agent_handle_key" ON "Agent"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_accountAddress_key" ON "Agent"("accountAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_apiKeyHash_key" ON "Agent"("apiKeyHash");

-- CreateIndex
CREATE INDEX "Payment_agentId_status_idx" ON "Payment"("agentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_agentId_idempotencyKey_key" ON "Payment"("agentId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Invoice_issuerAgentId_status_idx" ON "Invoice"("issuerAgentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SessionKey_address_key" ON "SessionKey"("address");

-- CreateIndex
CREATE INDEX "SessionKey_agentId_status_idx" ON "SessionKey"("agentId", "status");

-- CreateIndex
CREATE INDEX "TransactionLog_accountAddress_idx" ON "TransactionLog"("accountAddress");

-- CreateIndex
CREATE INDEX "TransactionLog_timestamp_idx" ON "TransactionLog"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionLog_txHash_logIndex_key" ON "TransactionLog"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "FaucetGrant_agentId_createdAt_idx" ON "FaucetGrant"("agentId", "createdAt");
