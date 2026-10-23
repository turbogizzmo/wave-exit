/**
 * Read-only queries against Wave's public schema (introspected 2026-10-23, see
 * docs/wave-api-schema.txt). Rules learned the hard way (docs/wave-api.md):
 * - every string argument goes through a variable;
 * - money: read `minorUnitValue`, never `value` (it has thousands separators);
 * - never ask for `subtype { systemCreated }` on an account node (Wave errors);
 * - `accounts` and `products` hide archived rows unless asked with isArchived: true.
 */

const MONEY = "minorUnitValue value";
const ADDRESS = "addressLine1 addressLine2 city postalCode province { code name } country { code name }";

export const Q_WHOAMI = /* GraphQL */ `
query WhoAmI { user { id defaultEmail firstName lastName } }`;

export const Q_BUSINESSES = /* GraphQL */ `
query Businesses($page: Int!) {
  businesses(page: $page, pageSize: 50) {
    pageInfo { totalPages }
    edges { node { id name isPersonal isArchived currency { code } } }
  }
}`;

export const Q_BUSINESS = /* GraphQL */ `
query Business($businessId: ID!) {
  business(id: $businessId) {
    id name isPersonal isArchived timezone createdAt modifiedAt
    currency { code symbol exponent }
    address { ${ADDRESS} }
  }
  accountSubtypes { name value systemCreated archivable type { value } }
}`;

export const Q_ACCOUNTS = /* GraphQL */ `
query Accounts($businessId: ID!, $page: Int!, $archived: Boolean!) {
  business(id: $businessId) {
    accounts(page: $page, pageSize: 200, isArchived: $archived) {
      pageInfo { totalPages totalCount }
      edges { node {
        id name description displayId isArchived balance balanceInBusinessCurrency normalBalanceType
        currency { code } type { value } subtype { value name }
      } }
    }
  }
}`;

const CONTACT_FIELDS = `id name firstName lastName displayId email mobile phone fax tollFree website currency { code } isArchived address { ${ADDRESS} }`;

export const Q_CUSTOMERS = /* GraphQL */ `
query Customers($businessId: ID!, $page: Int!) {
  business(id: $businessId) {
    customers(page: $page, pageSize: 200) {
      pageInfo { totalPages totalCount }
      edges { node { ${CONTACT_FIELDS} shippingDetails { name phone instructions address { ${ADDRESS} } } } }
    }
  }
}`;

export const Q_VENDORS = /* GraphQL */ `
query Vendors($businessId: ID!, $page: Int!) {
  business(id: $businessId) {
    vendors(page: $page, pageSize: 200) {
      pageInfo { totalPages totalCount }
      edges { node { ${CONTACT_FIELDS} } }
    }
  }
}`;

export const Q_PRODUCTS = /* GraphQL */ `
query Products($businessId: ID!, $page: Int!, $archived: Boolean!) {
  business(id: $businessId) {
    products(page: $page, pageSize: 200, isArchived: $archived) {
      pageInfo { totalPages totalCount }
      edges { node {
        id name description unitPrice isSold isBought isArchived
        incomeAccount { id } expenseAccount { id } defaultSalesTaxes { id }
      } }
    }
  }
}`;

export const Q_SALES_TAXES = /* GraphQL */ `
query SalesTaxes($businessId: ID!, $page: Int!, $archived: Boolean!) {
  business(id: $businessId) {
    salesTaxes(page: $page, pageSize: 200, isArchived: $archived) {
      pageInfo { totalPages totalCount }
      edges { node { id name abbreviation description taxNumber isCompound isRecoverable isArchived rates { effective rate } } }
    }
  }
}`;

export const Q_INVOICES = /* GraphQL */ `
query Invoices($businessId: ID!, $page: Int!) {
  business(id: $businessId) {
    invoices(page: $page, pageSize: 50, sort: [CREATED_AT_ASC]) {
      pageInfo { totalPages totalCount }
      edges { node {
        id invoiceNumber invoiceDate dueDate status title poNumber memo exchangeRate createdAt modifiedAt
        currency { code exponent }
        customer { id name }
        subtotal { ${MONEY} } taxTotal { ${MONEY} } discountTotal { ${MONEY} }
        total { ${MONEY} } amountPaid { ${MONEY} } amountDue { ${MONEY} }
        items {
          description quantity unitPrice
          subtotal { ${MONEY} } total { ${MONEY} }
          account { id } product { id }
          taxes { salesTax { id } amount { ${MONEY} } }
        }
        payments { id paymentDate amount paymentMethod active memo accountingTransactionId account { id } }
        attachments { fileName downloadUrl }
      } }
    }
  }
}`;

export const Q_ESTIMATES = /* GraphQL */ `
query Estimates($businessId: ID!, $page: Int!) {
  business(id: $businessId) {
    estimates(page: $page, pageSize: 50, sort: CREATED_AT_ASC) {
      pageInfo { totalPages totalCount }
      edges { node {
        id estimateNumber estimateDate dueDate status title poNumber memo
        currency { code exponent }
        customer { id name }
        subtotal { ${MONEY} } taxTotal { ${MONEY} } discountTotal { ${MONEY} } total { ${MONEY} }
        items { description quantity unitPrice total { ${MONEY} } account { id } product { id } }
      } }
    }
  }
}`;
