# B2B Quotes GraphQL

A VTEX IO GraphQL service that provides backend functionality for B2B quote management, enabling businesses to create, manage, and track quotes with advanced features like suggested orders based on purchase history.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Installation](#installation)
- [Configuration](#configuration)
- [GraphQL API](#graphql-api)
- [Development](#development)
- [Architecture](#architecture)
- [Dependencies](#dependencies)
- [Troubleshooting](#troubleshooting)

## Overview

This app is the backend service for B2B quote management in VTEX stores. It handles:

- Quote creation and lifecycle management
- Integration with VTEX Checkout and Order Management Systems
- B2B organization and cost center integration
- Intelligent product suggestions based on purchase history
- Multi-seller quote splitting and management
- Email notifications for quote events
- Analytics tracking for business metrics

## Features

### Core Functionality

- **Quote Management**: Create, update, and track quotes with full lifecycle support
- **Multi-seller Support**: Automatically split quotes by seller when configured
- **B2B Integration**: Seamless integration with VTEX B2B Organizations and Storefront Permissions
- **Cart Integration**: Convert quotes to cart items with a single action
- **Email Notifications**: Automated email alerts for quote status changes
- **Audit Trail**: Complete history tracking of quote modifications

### Intelligent Product Suggestions

The app includes a sophisticated product recommendation system that:

- Analyzes the last 90 days of purchase history
- Identifies the most frequently purchased items
- Calculates realistic suggested quantities based on the average of the last 2 orders
- Provides personalized recommendations per user
- Implements smart caching for improved performance

**Query Example**:
```graphql
query {
  generateQuoteSuggestion(input: { topN: 10 }) {
    items {
      id
      name
      skuName
      quantity
      price
      sellingPrice
      seller
    }
  }
}
```

The suggested `quantity` is calculated as the average from the last 2 orders containing that item, or defaults to 1 if the item hasn't appeared in recent orders.

## Installation

### Prerequisites

- VTEX IO CLI installed (`npm i -g vtex`)
- Node.js >= 12.x
- Access to a VTEX account with B2B features enabled

### Steps

1. Clone the repository:
```bash
git clone <repository-url>
cd b2b-quotes-graphql-pmi
```

2. Login to your VTEX account:
```bash
vtex login <account-name>
```

3. Create a development workspace:
```bash
vtex use <workspace-name>
```

4. Link the app:
```bash
vtex link
```

## Configuration

### Required Apps

This app depends on the following VTEX apps:

- `vtex.storefront-permissions@2.x` - B2B user permissions management
- `vtex.b2b-organizations-graphql@1.x` - Organization and cost center management
- `vtex.orders-broadcast@0.x` - Order event broadcasting

### Master Data Configuration

The app uses the following Master Data entities:

- **Quote Data Entity**: Stores quote information
- **Suggested Quotes Cache**: Caches product suggestions for improved performance

Ensure these entities are properly configured in your account's Master Data.

### App Settings

Configure the app settings through the GraphQL mutation:

```graphql
mutation {
  saveAppSettings(input: {
    adminSetup: {
      quotesManagedBy: "SELLER"
    }
  }) {
    adminSetup {
      quotesManagedBy
    }
  }
}
```

## GraphQL API

### Queries

#### `getQuote`
Retrieve a single quote by ID.

```graphql
query {
  getQuote(id: "quote-id") {
    id
    referenceName
    items {
      name
      quantity
      price
    }
    status
    creationDate
  }
}
```

#### `getQuotes`
List quotes with filtering and pagination.

```graphql
query {
  getQuotes(
    page: 1
    pageSize: 25
    sortOrder: "DESC"
    sortedBy: "lastUpdate"
  ) {
    data {
      id
      referenceName
      status
    }
    pagination {
      total
      page
      pageSize
    }
  }
}
```

#### `generateQuoteSuggestion`
Get intelligent product suggestions based on purchase history.

```graphql
query {
  generateQuoteSuggestion(input: { topN: 10 }) {
    items {
      id
      name
      quantity
      price
      seller
    }
  }
}
```

### Mutations

#### `createQuote`
Create a new quote.

```graphql
mutation {
  createQuote(input: {
    referenceName: "Q1 2025 Order"
    items: [
      {
        id: "1"
        quantity: 10
        price: 100
      }
    ]
    sendToSalesRep: false
  })
}
```

#### `updateQuote`
Update an existing quote.

```graphql
mutation {
  updateQuote(input: {
    id: "quote-id"
    items: [...]
    note: "Updated pricing"
  })
}
```

#### `useQuote`
Convert a quote to cart items.

```graphql
mutation {
  useQuote(
    id: "quote-id"
    orderFormId: "orderform-id"
  )
}
```

## Development

### Project Structure

```
.
├── graphql/
│   ├── schema.graphql       # Main GraphQL schema
│   ├── quote.graphql        # Quote types and inputs
│   ├── appSettings.graphql  # App configuration types
│   └── directives.graphql   # Custom directives
├── node/
│   ├── clients/             # External API clients
│   │   ├── oms.ts          # Order Management System client
│   │   └── ...
│   ├── resolvers/
│   │   ├── queries/        # GraphQL query resolvers
│   │   ├── mutations/      # GraphQL mutation resolvers
│   │   └── routes/         # REST endpoints
│   ├── utils/              # Helper functions
│   └── index.ts            # Service entry point
└── manifest.json           # App manifest
```

### Running Tests

```bash
npm run cy-r
```

### Code Quality

The project uses automated code quality tools:

- **ESLint**: Linting JavaScript/TypeScript
- **Prettier**: Code formatting
- **Husky**: Git hooks for pre-commit checks

Run manually:
```bash
npm run lint
npm run format
```

### Key Technologies

- **TypeScript**: Type-safe development
- **GraphQL**: API layer with Apollo Server
- **VTEX IO**: Platform and infrastructure
- **Node.js 6.x**: Runtime environment

## Architecture

### Data Flow

1. **GraphQL Request** → Custom directives validate permissions and session
2. **Resolver Execution** → Business logic processes the request
3. **External API Calls** → Integration with VTEX services (OMS, Checkout, Organizations)
4. **Master Data Storage** → Quote data persisted
5. **Event Emission** → Notifications and analytics triggered

### Caching Strategy

The app implements a multi-layer caching strategy:

- **GraphQL Caching**: Response-level caching with configurable TTL
- **Suggested Orders Cache**: 24-hour cache for product recommendations
- **Master Data**: Permanent storage for quotes

### Security

- **Session Validation**: `@withSession` directive
- **Permission Checks**: `@validateStoreUserAccess`, `@validateAdminUserAccess`
- **Role-Based Access**: Integration with Storefront Permissions
- **Audit Logging**: `@auditAccess` directive tracks access

## Dependencies

### VTEX Platform Dependencies

- `vtex.storefront-permissions@2.x`
- `vtex.b2b-organizations-graphql@1.x`
- `vtex.orders-broadcast@0.x`

### Required Policies

The app requires the following VTEX policies (configured in manifest.json):

- `vbase-read-write`: VBase storage access
- `OMSViewer`, `ListOrders`: Order Management System access
- `POWER_USER_DS`, `ADMIN_DS`: Master Data access
- `SaveOrderFormConfiguration`: Checkout configuration
- `send-message`: Email notifications
- Outbound access to VTEX APIs

## Troubleshooting

### Common Issues

**Issue**: "No items found for suggested quote"
- **Cause**: User has no orders in the last 90 days
- **Solution**: Adjust the date range in `computeTopSkus` function or ensure the user has purchase history

**Issue**: "operation-not-permitted"
- **Cause**: User lacks required permissions
- **Solution**: Ensure user has `create-quotes` permission in Storefront Permissions

**Issue**: Quotes not appearing for seller
- **Cause**: Seller not configured to receive quotes
- **Solution**: Configure seller quote settings via `checkSellerQuotes` query

### Debugging

Enable verbose logging:
```bash
vtex link --verbose
```

View logs in real-time:
```bash
vtex logs
```

### Performance Tips

- Use the `generateQuoteSuggestion` cache (24-hour TTL) to reduce API calls
- Implement pagination for large quote lists
- Monitor GraphQL query complexity and optimize as needed

## License

**Version:** 3.11.0-pmi
**Last Updated:** October 2025
**VTEX IO:** Compatible
**Status:** Active Development
