import type { NextRequest } from './spec-extension/request'
import type {
  AppRouteRouteHandlerContext,
  AppRouteRouteModule,
} from '../future/route-modules/app-route/module'
import type { PrerenderManifest } from '../../build'

import './globals'

import { adapter, type AdapterOptions } from './adapter'
import { IncrementalCache } from '../lib/incremental-cache'
import { RouteMatcher } from '../future/route-matchers/route-matcher'
import { removeTrailingSlash } from '../../shared/lib/router/utils/remove-trailing-slash'
import { removePathPrefix } from '../../shared/lib/router/utils/remove-path-prefix'
import type { NextFetchEvent } from './spec-extension/fetch-event'
import { internal_getCurrentFunctionWaitUntil } from './internal-edge-wait-until'

type WrapOptions = Partial<Pick<AdapterOptions, 'page'>>

/**
 * EdgeRouteModuleWrapper is a wrapper around a route module.
 *
 * Note that this class should only be used in the edge runtime.
 */
export class EdgeRouteModuleWrapper {
  private readonly matcher: RouteMatcher

  /**
   * The constructor is wrapped with private to ensure that it can only be
   * constructed by the static wrap method.
   *
   * @param routeModule the route module to wrap
   */
  private constructor(private readonly routeModule: AppRouteRouteModule) {
    // TODO: (wyattjoh) possibly allow the module to define it's own matcher
    this.matcher = new RouteMatcher(routeModule.definition)
  }

  /**
   * This will wrap a module with the EdgeModuleWrapper and return a function
   * that can be used as a handler for the edge runtime.
   *
   * @param module the module to wrap
   * @param options any options that should be passed to the adapter and
   *                override the ones passed from the runtime
   * @returns a function that can be used as a handler for the edge runtime
   */
  public static wrap(
    routeModule: AppRouteRouteModule,
    options: WrapOptions = {}
  ) {
    // Create the module wrapper.
    const wrapper = new EdgeRouteModuleWrapper(routeModule)

    // Return the wrapping function.
    return (opts: AdapterOptions) => {
      return adapter({
        ...opts,
        ...options,
        IncrementalCache,
        // Bind the handler method to the wrapper so it still has context.
        handler: wrapper.handler.bind(wrapper),
      })
    }
  }

  private async handler(
    request: NextRequest,
    evt: NextFetchEvent
  ): Promise<Response> {
    // Get the pathname for the matcher. Pathnames should not have trailing
    // slashes for matching.
    let pathname = removeTrailingSlash(new URL(request.url).pathname)

    // Get the base path and strip it from the pathname if it exists.
    const { basePath } = request.nextUrl
    if (basePath) {
      // If the path prefix doesn't exist, then this will do nothing.
      pathname = removePathPrefix(pathname, basePath)
    }

    // Get the match for this request.
    const match = this.matcher.match(pathname)
    if (!match) {
      throw new Error(
        `Invariant: no match found for request. Pathname '${pathname}' should have matched '${this.matcher.definition.pathname}'`
      )
    }

    const prerenderManifest: PrerenderManifest | undefined =
      typeof self.__PRERENDER_MANIFEST === 'string'
        ? JSON.parse(self.__PRERENDER_MANIFEST)
        : undefined

    // Create the context for the handler. This contains the params from the
    // match (if any).
    const context: AppRouteRouteHandlerContext = {
      params: match.params,
      prerenderManifest: {
        version: 4,
        routes: {},
        dynamicRoutes: {},
        preview: prerenderManifest?.preview || {
          previewModeEncryptionKey: '',
          previewModeId: 'development-id',
          previewModeSigningKey: '',
        },
        notFoundRoutes: [],
      },
      renderOpts: {
        supportsDynamicHTML: true,
        // App Route's cannot be postponed.
        ppr: false,
      },
    }

    // Get the response from the handler.
    const res = await this.routeModule.handle(request, context)

    const waitUntilPromises = [internal_getCurrentFunctionWaitUntil()]
    if (context.renderOpts.waitUntil) {
      waitUntilPromises.push(context.renderOpts.waitUntil)
    }
    evt.waitUntil(Promise.all(waitUntilPromises))

    return res
  }
}
