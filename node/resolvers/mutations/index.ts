import { indexBy, map, prop } from 'ramda'

import {
  APP_NAME,
  QUOTE_DATA_ENTITY,
  QUOTE_FIELDS,
  routes,
  SCHEMA_VERSION,
} from '../../constants'
import { sendCreateQuoteMetric } from '../../metrics/createQuote'
import type { UseQuoteMetricsParams } from '../../metrics/useQuote'
import { sendUseQuoteMetric } from '../../metrics/useQuote'
import { isEmail } from '../../utils'
import GraphQLError from '../../utils/GraphQLError'
import message from '../../utils/message'
import {resolvers as BaseResolvers} from "../index";
import {
  checkAndCreateQuotesConfig,
  checkConfig,
  defaultSettings,
} from '../utils/checkConfig'
import {
  checkOperationsForUpdateQuote,
  checkPermissionsForUpdateQuote,
  checkQuoteStatus,
  checkSession,
} from '../utils/checkPermissions'
import {
  createItemComparator,
  createQuoteObject,
  splitItemsBySeller,
} from '../utils/quotes'
import SellerQuotesController from '../utils/sellerQuotesController'

const TOP_N = 10
const DEFAULT_PER_PAGE = 15
const DEFAULT_MAX_ORDERS = 60

const SUGGESTED_CACHE_ENTITY = 'suggested_quotes_cache'
const CACHE_TTL_HOURS = 24

async function getTopSkusFromCache(ctx: Context, userKey: string) {
  const { masterdata } = ctx.clients as any
  try {
    const cacheResults = await masterdata.searchDocuments({
      dataEntity: SUGGESTED_CACHE_ENTITY,
      fields: ['id', 'items', 'cachedAt'],
      page: 1,
      pageSize: 1,
      where: `userKey=${userKey}`,
    })

    if (cacheResults.length > 0) {
      const { items, cachedAt } = cacheResults[0]
      const cacheAge = Date.now() - new Date(cachedAt).getTime()
      const cacheExpired = cacheAge > (CACHE_TTL_HOURS * 60 * 60 * 1000)

      if (!cacheExpired && items) {
        return JSON.parse(items)
      }
    }
  } catch (error) {
    ctx.vtex?.logger?.warn({ msg: 'Failed to get cached suggestions', userKey, error })
  }
  return null
}

async function saveCache(ctx: Context, userKey: string, items: any[]) {
  const { masterdata } = ctx.clients as any
  try {
    const existing = await masterdata.searchDocuments({
      dataEntity: SUGGESTED_CACHE_ENTITY,
      fields: ['id'],
      page: 1,
      pageSize: 1,
      where: `userKey=${userKey}`,
    })

    const cacheData = {
      cachedAt: new Date().toISOString(),
      items: JSON.stringify(items),
      userKey,
    }

    if (existing.length > 0) {
      await masterdata.updatePartialDocument({
        dataEntity: SUGGESTED_CACHE_ENTITY,
        fields: cacheData,
        id: existing[0].id,
      })
    } else {
      await masterdata.createDocument({
        dataEntity: SUGGESTED_CACHE_ENTITY,
        fields: cacheData,
      })
    }
  } catch (error) {
    ctx.vtex?.logger?.warn({ msg: 'Failed to cache suggestions', userKey, error })
  }
}

async function computeTopSkus(ctx: Context, userKey: string, topN: number) {
  const { oms } = ctx.clients
  const authCookie = ctx.vtex.authToken || ctx.cookies?.get('VtexIdclientAutCookie') || ''
  let page = 1
  let fetched = 0
  const qtyBySku = new Map<string, {
    qty: number
    lastPurchasedAt?: string
    itemData: any
  }>()

  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  const dateFilter = thirtyDaysAgo.toISOString().split('T')[0]

  while (fetched < DEFAULT_MAX_ORDERS) {
    const params: any = {
      f_clientEmail: userKey.includes('@') ? userKey : undefined,
      f_creationDate: `creationDate:[${dateFilter} TO *]`,
      orderBy: 'creationDate,desc',
      page,
      per_page: DEFAULT_PER_PAGE,
    }

    const list = await oms.listOrders(authCookie, params)
    const orders: any[] = list?.list || list?.orders || []
    if (!orders.length) {
      break
    }

    for (const o of orders) {
      if (fetched >= DEFAULT_MAX_ORDERS) {
        break
      }

      const orderId = o.orderId || o.orderIdFormatted || o.orderIdClean
      if (!orderId) {
        continue
      }

      const full = await oms.getOrder(orderId, authCookie)
      const items: any[] = full?.items || []
      const createdAt: string | undefined = full?.creationDate || o?.creationDate

      for (const it of items) {
        const skuId = String(it.id ?? it.skuId ?? '')
        const quantity = Number(it.quantity || 0)

        if (!skuId || !quantity) {
          continue
        }

        const prev = qtyBySku.get(skuId) || {
          itemData: null,
          qty: 0,
        }

        const lastPurchasedAt =
            createdAt && (!prev.lastPurchasedAt || createdAt > prev.lastPurchasedAt)
                ? createdAt
                : prev.lastPurchasedAt

        const itemData = prev.itemData || {
          id: skuId,
          imageUrl: it.imageUrl || '',
          listPrice: Number(it.listPrice || it.price || it.sellingPrice || 0),
          name: it.name || it.skuName || `Product ${skuId}`,
          price: Number(it.price || it.sellingPrice || 0),
          productId: it.productId || skuId,
          refId: it.refId || '',
          seller: it.seller || '1',
          sellingPrice: Number(it.sellingPrice || it.price || 0),
          skuName: it.skuName || it.name || `SKU ${skuId}`,
        }

        qtyBySku.set(skuId, {
          itemData,
          lastPurchasedAt,
          qty: prev.qty + quantity,
        })
      }

      fetched++
    }

    if (orders.length < DEFAULT_PER_PAGE) {
      break
    }

    page++
  }

  const result = Array.from(qtyBySku.entries())
      .sort((a, b) => b[1].qty - a[1].qty)
      .slice(0, topN)
      .map(([skuId, v]) => ({
        itemData: v.itemData,
        lastPurchasedAt: v.lastPurchasedAt,
        qty: v.qty,
        skuId,
      }))

  return result
}

export const Mutation = {
  clearCart: async (_: any, params: any, ctx: Context) => {
    const {
      vtex: { account, logger },
      clients: { hub },
    } = ctx

    try {
      await hub.post(routes.clearCart(account, params.orderFormId), {
        expectedOrderFormSections: ['items'],
      })
    } catch (error) {
      logger.error({
        error,
        message: 'clearCart-error',
      })
      if (error.message) {
        throw new GraphQLError(error.message)
      } else if (error.response?.data?.message) {
        throw new GraphQLError(error.response.data.message)
      } else {
        throw new GraphQLError(error)
      }
    }
  },
  createQuote: async (
    _: any,
    {
      input: { referenceName, items, subtotal, note, sendToSalesRep },
    }: {
      input: {
        referenceName: string
        items: QuoteItem[]
        subtotal: number
        note: string
        sendToSalesRep: boolean
      }
    },
    ctx: Context
  ) => {
    const {
      clients: { masterdata },
      vtex,
      vtex: { logger },
    } = ctx

    const settings = await checkConfig(ctx)
    const { sessionData, storefrontPermissions, segmentData } = vtex as any

    checkSession(sessionData)

    if (!storefrontPermissions?.permissions?.includes('create-quotes')) {
      throw new GraphQLError('operation-not-permitted')
    }

    try {
      let quoteBySeller: SellerQuoteMap = {}

      if (settings?.adminSetup.quotesManagedBy === 'SELLER') {
        const sellerItems = items.filter(
          ({ seller }) => seller && seller !== '1'
        )

        quoteBySeller = await splitItemsBySeller({
          ctx,
          items: sellerItems,
        })
      }

      const sellerQuotesQuantity = Object.keys(quoteBySeller).length

      const remainingItems = items.filter(
        (item) =>
          !Object.values(quoteBySeller).some((quote) =>
            quote.items.some(createItemComparator(item))
          )
      )

      const oneSellerQuoteAndNoRemainingItems =
        sellerQuotesQuantity === 1 && !remainingItems.length

      const isOnlyOneQuote =
        !sellerQuotesQuantity || oneSellerQuoteAndNoRemainingItems

      const [firstSellerQuote] = Object.values(quoteBySeller)

      let parentQuoteItems = sellerQuotesQuantity ? remainingItems : items

      if (isOnlyOneQuote && firstSellerQuote) {
        parentQuoteItems = firstSellerQuote.items
      }

      const quoteCommonFields = {
        sessionData,
        storefrontPermissions,
        segmentData,
        settings,
        referenceName,
        note,
        sendToSalesRep,
        sellerQuotesQuantity,
      }

      const parentQuote = createQuoteObject({
        ...quoteCommonFields,
        items: parentQuoteItems,
        subtotal,
        ...(isOnlyOneQuote &&
          firstSellerQuote && {
            seller: firstSellerQuote.seller,
            sellerName: firstSellerQuote.sellerName,
          }),
      })

      const { DocumentId: parentQuoteId } = await masterdata.createDocument({
        dataEntity: QUOTE_DATA_ENTITY,
        fields: parentQuote,
        schema: SCHEMA_VERSION,
      })

      if (isOnlyOneQuote && firstSellerQuote) {
        await ctx.clients.sellerQuotes.notifyNewQuote(
          firstSellerQuote.seller,
          parentQuoteId,
          parentQuote.creationDate
        )
      }

      if (!isOnlyOneQuote) {
        const childrenQuoteIds: string[] = []

        if (parentQuoteItems.length) {
          const marketplaceSubtotal = parentQuoteItems.reduce(
            (acc, item) => acc + item.sellingPrice * item.quantity,
            0
          )

          const marketplaceSeller = await ctx.clients.seller.getSeller('1')

          const marketplaceQuote = createQuoteObject({
            ...quoteCommonFields,
            items: parentQuoteItems,
            subtotal: marketplaceSubtotal,
            seller: '1',
            sellerName: marketplaceSeller?.name ?? ctx.vtex.account,
            parentQuote: parentQuoteId,
          })

          const {
            DocumentId: markerplaceQuoteId,
          } = await masterdata.createDocument({
            dataEntity: QUOTE_DATA_ENTITY,
            fields: marketplaceQuote,
            schema: SCHEMA_VERSION,
          })

          childrenQuoteIds.push(markerplaceQuoteId)
        }

        const sellerQuoteIds = await Promise.all(
          Object.entries(quoteBySeller).map(async ([seller, sellerQuote]) => {
            const sellerQuoteObject = createQuoteObject({
              ...quoteCommonFields,
              ...sellerQuote,
              parentQuote: parentQuoteId,
            })

            const data = await masterdata.createDocument({
              dataEntity: QUOTE_DATA_ENTITY,
              fields: sellerQuoteObject,
              schema: SCHEMA_VERSION,
            })

            await ctx.clients.sellerQuotes.notifyNewQuote(
              seller,
              data.DocumentId,
              sellerQuoteObject.creationDate
            )

            return data.DocumentId
          })
        )

        childrenQuoteIds.push(...sellerQuoteIds)

        if (childrenQuoteIds.length) {
          await masterdata.updatePartialDocument({
            dataEntity: QUOTE_DATA_ENTITY,
            fields: {
              hasChildren: true,
              childrenQuantity: childrenQuoteIds.length,
            },
            id: parentQuoteId,
            schema: SCHEMA_VERSION,
          })
        }
      }

      if (sendToSalesRep) {
        message(ctx)
          .quoteCreated({
            costCenter: parentQuote.costCenter,
            id: parentQuoteId,
            lastUpdate: {
              email: parentQuote.creatorEmail,
              note,
              status: parentQuote.status.toUpperCase(),
            },
            name: referenceName,
            organization: parentQuote.organization,
          })
          .then(() => {
            logger.info({
              message: `[Quote created] E-mail sent to sales reps`,
            })
          })
      }

      const metricsParam = {
        sessionData,
        userData: {
          orgId: parentQuote.organization,
          costId: parentQuote.costCenter,
          roleId: parentQuote.creatorRole,
        },
        costCenterName: 'costCenterData?.getCostCenterById?.name',
        buyerOrgName: 'organizationData?.getOrganizationById?.name',
        quoteId: parentQuoteId,
        quoteReferenceName: referenceName,
        sendToSalesRep,
        creationDate: parentQuote.creationDate,
      }

      sendCreateQuoteMetric(ctx, metricsParam)

      return parentQuoteId
    } catch (error) {
      logger.error({
        error,
        message: 'createQuote-error ',
      })

      const errorMessage =
        error.message || error.response?.data?.message || error

      throw new GraphQLError(errorMessage)
    }
  },
  updateQuote: async (
    _: any,
    {
      input: { id, items, subtotal, note, decline, expirationDate },
    }: {
      input: {
        id: string
        items: QuoteItem[]
        subtotal: number
        note: string
        decline: boolean
        expirationDate: string
      }
    },
    ctx: Context
  ) => {
    const {
      clients: { masterdata },
      vtex,
      vtex: { logger },
    } = ctx

    const { sessionData, storefrontPermissions } = vtex as any

    checkSession(sessionData)

    const email = sessionData.namespaces.profile.email.value
    const {
      permissions,
      role: { slug },
    } = storefrontPermissions

    const isCustomer = slug.includes('customer')
    const isSales = slug.includes('sales')
    const itemsChanged = items?.length > 0

    checkPermissionsForUpdateQuote({
      permissions,
      itemsChanged,
      decline,
    })

    const {
      organization: { value: userOrganizationId },
      costcenter: { value: userCostCenterId },
    } = sessionData.namespaces['storefront-permissions']

    const now = new Date()
    const nowISO = now.toISOString()

    try {
      const existingQuote: Quote = await masterdata.getDocument({
        dataEntity: QUOTE_DATA_ENTITY,
        fields: QUOTE_FIELDS,
        id,
      })

      checkQuoteStatus(existingQuote)

      const expirationChanged = expirationDate !== existingQuote.expirationDate

      checkOperationsForUpdateQuote({
        permissions,
        expirationChanged,
        itemsChanged,
        existingQuote,
        userCostCenterId,
        userOrganizationId,
        declineQuote: decline,
      })

      const readyOrRevised = itemsChanged ? 'ready' : 'revised'
      const status = decline ? 'declined' : readyOrRevised

      const lastUpdate = nowISO
      const update = {
        date: nowISO,
        email,
        note,
        role: slug,
        status,
      }

      const { updateHistory } = existingQuote

      updateHistory.push(update)

      const updatedQuote: Quote = {
        ...existingQuote,
        expirationDate: expirationChanged
          ? expirationDate
          : existingQuote.expirationDate,
        items: itemsChanged ? items : existingQuote.items,
        lastUpdate,
        status,
        subtotal: subtotal ?? existingQuote.subtotal,
        updateHistory,
        viewedByCustomer: !!(decline || isCustomer),
        viewedBySales: !!(decline || isSales),
      }

      const data = await masterdata
        .updateEntireDocument({
          dataEntity: QUOTE_DATA_ENTITY,
          fields: updatedQuote,
          id,
          schema: SCHEMA_VERSION,
        })
        .then((res: any) => res)

      const sellerQuotesController = new SellerQuotesController(ctx)

      if (existingQuote.parentQuote) {
        sellerQuotesController.handleParentQuoteSubtotalAndStatus(
          existingQuote.parentQuote
        )
      }

      const users = updateHistory.map((anUpdate) => anUpdate.email)
      const uniqueUsers = [
        ...new Set(
          users.filter((userEmail: string) => isEmail.test(userEmail))
        ),
      ]

      message(ctx)
        .quoteUpdated({
          costCenter: existingQuote.costCenter,
          id: existingQuote.id,
          lastUpdate: {
            email,
            note,
            status: status.toUpperCase(),
          },
          name: existingQuote.referenceName,
          organization: existingQuote.organization,
          users: uniqueUsers,
        })
        .then(() => {
          logger.info({
            message: `[Quote updated] E-mail sent ${uniqueUsers.join(', ')}`,
          })
        })

      return data.id
    } catch (error) {
      logger.warn({
        error,
        message: 'updateQuote-warning',
      })
      throw new GraphQLError(error)
    }
  },
  useQuote: async (
    _: any,
    { id, orderFormId }: { id: string; orderFormId: string },
    ctx: Context
  ) => {
    const {
      clients: { masterdata, hub },
      vtex,
      vtex: { account, logger, authToken },
    } = ctx

    const { sessionData, storefrontPermissions } = vtex as any

    checkSession(sessionData)

    const { permissions } = storefrontPermissions

    if (!permissions.includes('use-quotes')) {
      throw new GraphQLError('operation-not-permitted')
    }

    const useHeaders = {
      'Content-Type': 'application/json',
      Cookie: `VtexIdclientAutCookie=${authToken};`,
    }

    try {
      // GET QUOTE DATA
      const mainQuote: Quote = await masterdata.getDocument({
        dataEntity: QUOTE_DATA_ENTITY,
        fields: QUOTE_FIELDS,
        id,
      })

      const quotes: Quote[] = []
      const items: QuoteItem[] = []

      if (mainQuote.hasChildren) {
        const sellerQuotesController = new SellerQuotesController(ctx)
        const childrenQuotes = await sellerQuotesController.getAllChildrenQuotes(
          id
        )

        let errorsCount = 0

        for (const quote of childrenQuotes) {
          try {
            checkQuoteStatus(quote)
            quotes.push(quote)
          } catch (e) {
            if (++errorsCount === childrenQuotes.length) {
              throw e
            }

            continue
          }
        }
      } else {
        checkQuoteStatus(mainQuote)
        quotes.push(mainQuote)
      }

      for (const quote of quotes) {
        items.push(...quote.items)
      }

      const { salesChannel } = mainQuote

      // CLEAR CURRENT CART
      if (orderFormId !== 'default-order-form') {
        await hub.post(
          routes.clearCart(account, orderFormId),
          {
            expectedOrderFormSections: ['items'],
          },
          useHeaders
        )
      }

      // CREATE CART IF IT DOESN'T EXIST YET
      if (orderFormId === 'default-order-form') {
        const newOrderForm = await hub.get(
          routes.orderForm(account),
          useHeaders
        )

        orderFormId = (newOrderForm.data as any).orderFormId
      }

      await checkAndCreateQuotesConfig(ctx)
      await hub
        .put(
          routes.addCustomData({
            account,
            orderFormId,
            appId: APP_NAME,
            property: 'quoteId',
          }),
          {
            value: id,
          },
          useHeaders
        )
        .then((res: any) => {
          return res.data
        })
        .catch((error) =>
          logger.error({
            error,
            message: 'useQuote-addCustomDataError',
          })
        )

      const salesChannelQueryString = salesChannel ? `?sc=${salesChannel}` : ''

      // ADD ITEMS TO CART
      const data = await hub
        .post(
          `${routes.addToCart(account, orderFormId)}${salesChannelQueryString}`,
          {
            expectedOrderFormSections: ['items'],
            orderItems: items.map((item) => {
              return {
                id: item.id,
                quantity: item.quantity,
                seller: item.seller || '1',
              }
            }),
          }
        )
        .then((res: any) => {
          return res.data
        })

      const { items: itemsAdded } = data

      const sellingPriceMap = indexBy(
        prop('id'),
        map(
          (item: any) => ({
            id: item.id,
            price: item.sellingPrice,
          }),
          items
        )
      )

      const orderItems: any[] = []

      itemsAdded.forEach((item: any, key: number) => {
        orderItems.push({
          index: key,
          price: prop(item.id, sellingPriceMap).price,
          quantity: null,
        })
      })

      await hub.post(
        routes.addPriceToItems(account, orderFormId),
        {
          orderItems,
        },
        useHeaders
      )

      for (const quote of quotes) {
        const metricParams: UseQuoteMetricsParams = {
          quote,
          orderFormId,
          account,
          userEmail: sessionData?.namespaces?.profile?.email?.value,
        }

        sendUseQuoteMetric(ctx, metricParams)
      }
    } catch (error) {
      logger.error({
        error,
        message: 'useQuote-error',
      })
      if (error.message) {
        throw new GraphQLError(error.message)
      } else if (error.response?.data?.message) {
        throw new GraphQLError(error.response.data.message)
      } else {
        throw new GraphQLError(error)
      }
    }
  },
  saveAppSettings: async (
    _: void,
    {
      input: { cartLifeSpan, quotesManagedBy = 'MARKETPLACE' },
    }: { input: { cartLifeSpan: number; quotesManagedBy: string } },
    ctx: Context
  ) => {
    const {
      clients: { vbase },
      vtex: { logger },
    } = ctx

    let settings = null
    let noSettingsFound = false

    try {
      settings = await vbase.getJSON<Settings | null>(
        APP_NAME,
        'settings',
        true
      )
    } catch (error) {
      logger.error({
        error,
        message: 'saveAppSettings-getAppSettingsError',
      })

      return null
    }

    if (!settings) {
      settings = defaultSettings
      noSettingsFound = true
    }

    const newSettings = {
      ...settings,
      adminSetup: {
        ...settings.adminSetup,
        cartLifeSpan,
        quotesManagedBy,
      },
    }

    try {
      await vbase.saveJSON(APP_NAME, 'settings', newSettings)
    } catch (error) {
      logger.error({
        error,
        message: 'saveAppSettings-saveAppSettingsError',
      })

      return noSettingsFound ? null : settings
    }

    return newSettings
  },
  generateQuoteSuggestion: async (_: unknown, args: any, ctx: Context) => {
    try {
      ctx.vtex?.logger?.info({ msg: 'createSuggestedQuote started', args })

      const { input } = args || {}

      const { sessionData, storefrontPermissions } = ctx.vtex as any

      const profileEmail = sessionData?.namespaces?.profile?.email?.value
      const adminEmail = sessionData?.namespaces?.authentication?.adminUserEmail?.value
      const email = profileEmail || adminEmail

      if (!email) {
        throw new Error('Not authenticated: missing user email in session')
      }

      const isAdminUser = !!adminEmail
      const hasCreateQuotesPermission = storefrontPermissions?.permissions?.includes('create-quotes')

      if (!isAdminUser && !hasCreateQuotesPermission) {
        throw new Error('operation-not-permitted')
      }

      const userKey = email
      const topN = Number(input?.topN ?? TOP_N)

      let topItems = await getTopSkusFromCache(ctx, userKey).catch((err) => {
        ctx.vtex?.logger?.warn({ msg: 'Cache fetch failed', userKey, error: err.message })
        return null
      })
      if (!topItems) {
        ctx.vtex?.logger?.info({ msg: 'No cache found, computing top SKUs' })
        try {
          topItems = await computeTopSkus(ctx, userKey, topN)
          await saveCache(ctx, userKey, topItems).catch(() => undefined)
        } catch (error) {
          ctx.vtex?.logger?.error({
            error: (error as any).message,
            msg: 'Failed to compute top SKUs',
            status: (error as any).response?.status,
            statusText: (error as any).response?.statusText,
            userKey,
          })
          throw new Error(`Failed to fetch order history: ${(error as any).message}`)
        }
      } else {
        ctx.vtex?.logger?.info({ msg: 'Using cached top SKUs', itemCount: topItems.length })
      }

      if (!topItems?.length) {
        throw new Error('No items found for suggested quote')
      }

      const quoteItems = topItems.map((i: any) => ({
        ...i.itemData,
        quantity: Number(i.qty),
      }))

      if (!BaseResolvers?.Mutation?.createQuote) {
        throw new Error('Base createQuote resolver not available')
      }

      const createInput = {
        items: quoteItems,
        note: '',
        referenceName: 'Suggested Order',
        sendToSalesRep: false,
        subtotal: 0,
      }

      const contextForCreateQuote = { ...ctx } as any
      if (isAdminUser && !sessionData?.namespaces['storefront-permissions']) {
        contextForCreateQuote.vtex.sessionData = {
          ...sessionData,
          namespaces: {
            ...sessionData.namespaces,
            profile: {
              ...sessionData.namespaces.profile,
              email: { value: email },
            },
            'storefront-permissions': {
              costcenter: { value: 'admin-cc' },
              organization: { value: 'admin-org' },
            },
          },
        }
        contextForCreateQuote.vtex.storefrontPermissions = {
          permissions: ['create-quotes'],
          role: { slug: 'admin' },
        }
      }

      let created
      try {
        created = await BaseResolvers.Mutation.createQuote(_, { input: createInput }, contextForCreateQuote)
        ctx.vtex?.logger?.info({
          created,
          createdType: typeof created,
          msg: 'createQuote succeeded',
        })
      } catch (err) {
        ctx.vtex?.logger?.error({
          err: String((err as any)?.message || err),
          input: createInput,
          msg: 'createQuote failed',
        })
        throw new Error(`createQuote failed: ${String((err as any)?.message || err)}`)
      }

      if (!created) {
        throw new Error('createQuote returned empty response')
      }

      const quoteId = created
      ctx.vtex?.logger?.info({ msg: 'Attempting to retrieve created quote from Master Data', quoteId })

      const quoteData = await ctx.clients.masterdata.getDocument({
        dataEntity: QUOTE_DATA_ENTITY,
        fields: QUOTE_FIELDS,
        id: quoteId,
      })

      if (!quoteData) {
        throw new Error(`Failed to retrieve created quote with ID: ${quoteId}`)
      }

      const data = quoteData as any

      let parsedItems
      try {
        if (typeof data.items === 'string') {
          parsedItems = JSON.parse(data.items)
        } else if (Array.isArray(data.items)) {
          parsedItems = data.items
        } else {
          parsedItems = []
        }
      } catch (parseError) {
        ctx.vtex?.logger?.warn({
          msg: 'Failed to parse items, using empty array',
          items: data.items,
          parseError: (parseError as any).message,
        })
        parsedItems = []
      }

      return {
        costCenter: data.costCenter || null,
        costCenterName: data.costCenterName || null,
        creationDate: data.creationDate,
        creatorEmail: data.creatorEmail,
        creatorName: data.creatorName || data.creatorEmail?.split('@')[0],
        creatorRole: data.creatorRole,
        expirationDate: data.expirationDate,
        id: data.id,
        items: parsedItems,
        lastUpdate: data.lastUpdate,
        organization: data.organization || null,
        organizationName: data.organizationName || null,
        referenceName: data.referenceName,
        status: data.status,
        subtotal: parseFloat(data.subtotal || '0'),
      }
    } catch (error) {
      console.log('❌ createSuggestedQuote ERROR', { error: error.message, stack: error.stack })
      ctx.vtex?.logger?.error({
        error: String((error as any)?.message || error),
        msg: 'createSuggestedQuote failed',
        stack: (error as any)?.stack,
      })
      throw error
    }
  },
}
