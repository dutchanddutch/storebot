// const { get, set, uniq, uniq, flatten, flattenDeep } = require( 'lodash' );
// import * as _ from 'lodash';
import get from './node_modules/lodash-es/get.js';
import set from './node_modules/lodash-es/set.js'
import flatten from './node_modules/lodash-es/flatten.js'
import flattenDeep from './node_modules/lodash-es/flattenDeep.js'
import uniq from './node_modules/lodash-es/uniq.js'

const uuid = window.crypto.randomUUID().substr(8);

const createUnhandledPathHandler = ( p, log ) => ( v, s ) =>
      log.info( `Unhandled change on path "${p}"`, { rawData: JSON.stringify( v ) } );

const unRootPath = str =>
      str.replace( 'root.', '' ).replace( 'root', '' );

const clone = obj =>
      JSON.parse( JSON.stringify( obj ));

const prepListenerObjects = function( state, listeners, log, noValueDefault )
{
    const listenableSpace = clone({ root: state });
    const listenerObject = {};
    const indexedState = {};

    for ( let listenerConfig of listeners )
    {
        for ( let listenerPath of Array.isArray( listenerConfig.path ) ? listenerConfig.path : [ listenerConfig.path ] )
        {
            if ( listenerPath !== '' && get( state, listenerPath, undefined ) === undefined )
            {
                log.error( `Incompatible state and listener on path "${listenerPath}"` )
                // throw new Error( `Incompatible state and listener on path "${listenerPath}"` )
            }

            const id                    = listenerConfig.id
            const pathToListenerSet     = 'root' + ( listenerPath ? '.' : '' ) + listenerPath + '["%listeners%"]'
            const handlerSet            = { [ id ]: listenerConfig, ...get( listenerObject, pathToListenerSet, {} ) }

            set( listenerObject, pathToListenerSet, handlerSet )

            if ( indexedState[ listenerPath ] === undefined )
            {
                // TODO: deal with array indexes in paths
                const getter            = buildObjGetter( listenerPath.split( '.' ), noValueDefault )

                indexedState[ listenerPath ] = {
                    lens            : getter
                    ,   cache           : getter( state )
                }
            }
        }
    }

    return { listenableSpace, listenerObject, indexedState }
}



const createPathListenerDictionary  = ( obj, pathPrefix, listenerRegisterObject, parentListenerSet ) =>
      {
          const pathListenerDictionary = {}

          // console.log( 'path prefix:', pathPrefix )

          if ( pathPrefix.length > 0 && pathPrefix.substr( -1 ) !== '.' )
          {
              throw new Error( 'pathPrefix should end on a "." (dot) character' )
          }

          for ( let [ key, value ] of Object.entries( obj ))
          {
              // console.debug( 'sub path', key )

              if ( key === '%listeners%' )
              {
                  continue
              }

              // we'll be preparing the listeners for this path in the state
              const pathToHandle          = pathPrefix + key

              // set default handler array (the one used in the previous layer)
              let nextParentListenerSet   = parentListenerSet

              let childListenerSets       = []

              // check whether listeners are defined for this specific state path
              const listenersDefinedForPath       = get( listenerRegisterObject, pathToHandle + '["%listeners%"]', false )

              if ( listenersDefinedForPath )
              {
                  // if defined, overwrite the default listener array with the 'new' listeners
                  nextParentListenerSet = { listeners: Object.values( listenersDefinedForPath ), path: pathToHandle }
              }

              if ( typeof( value ) === 'object' && value !== null )
              {
                  const subPath                   = pathPrefix + key + '.'
                  const subPathListenerDictionary = createPathListenerDictionary(
                      value
                      ,   subPath
                      ,   listenerRegisterObject
                      ,   nextParentListenerSet
                  )

                  for ( let subListeners of Object.values( subPathListenerDictionary ))
                  {
                      childListenerSets.push(
                          ...subListeners.childListenerSets.filter( lSet => ! childListenerSets.includes( lSet ))
                      )

                      if ( subListeners.parentListenerSet !== nextParentListenerSet && ! childListenerSets.includes( subListeners.parentListenerSet ) )
                      {
                          // lower element has a different specific listener -> add to my children
                          childListenerSets.push( subListeners.parentListenerSet )
                      }
                  }

                  Object.assign( pathListenerDictionary, subPathListenerDictionary )
              }

              // add the array of listeners to the dictionary
              pathListenerDictionary[ pathToHandle ]  = {
                  parentListenerSet   : nextParentListenerSet
                  ,   childListenerSets
              }

          }

          return pathListenerDictionary
      }

const wrapListenerArrays            = function( pathListenerDictionary, indexedState, log )
{
    const wrappedListenerRegister   = {}

    for ( let [ statePath, relevantListenerSets ] of Object.entries( pathListenerDictionary ) )
    {
        const rootLessChangePath        = unRootPath( statePath )

        if ( ! relevantListenerSets.parentListenerSet.listeners )
        {
            // no parent defined -> no handler
            wrappedListenerRegister[ rootLessChangePath ] = createUnhandledPathHandler( statePath, log )
            continue
        }
        // the handlers functions per listener that were defined for the change path OR its neirest parent
        // can be more than one, as multiple listeners can be defined for one path
        const parentListenerHandlers            = uniq( relevantListenerSets.parentListenerSet.listeners.map( l => l.handler ) )

        // all of the paths that the parent listeners listen to (as a listener can listen/sbuscribe to more than one path)
        const parentListenerPaths               = uniq( flatten( relevantListenerSets.parentListenerSet.listeners.map( l => l.path ) ) )

        // one rifng to rule them all
        const bundledParentListenerHandlers     = bundleFns( parentListenerHandlers )

        const hasChildrenListeners              = relevantListenerSets.childListenerSets.length > 0

        // an array with all handlers of the different children listeners, meaning all listeners that
        // were defined for a point in the state tree below the current statePath
        const childrenListenerHandlers          = uniq( flattenDeep( relevantListenerSets.childListenerSets.map( cls => cls.listeners.map( l => l.handler ) ) ) )
        const childrenListenerPaths             = uniq( flattenDeep( relevantListenerSets.childListenerSets.map( cls => cls.listeners.map( l => l.path ) ) ) )

        // bundlify
        const bundledChildrenListenerHandlers   = bundleFns( childrenListenerHandlers )

        // paths without { root: <state> } wrapping
        const rootLessParentListPath    = unRootPath( relevantListenerSets.parentListenerSet.path )
        const childrensPaths            = relevantListenerSets.childListenerSets.map( cls => unRootPath( cls.path ) )

        // this function updates the cached state values for all children listeners
        const updateChildrensCaches     = bundleFns( childrensPaths.map( cp => state => indexedState[ cp ].cache = indexedState[ cp ].lens( state.data ) ))

        // shortcut to the state cache and state cache update fn of this statePath
        const indexedParentListState    = indexedState[ rootLessParentListPath ]

        // function that updates this statePath's cache - if this path is updated directly, just put the new value
        // in the cache, otherwise use the getter (lens)
        const parentCacheUpdateFn       = rootLessParentListPath === rootLessChangePath
              ?   function( changeValue )
        {
            indexedParentListState.cache = changeValue
        }
        :   function( changeValue, state )
        {
            indexedParentListState.cache = indexedParentListState.lens( state.data )
        }

        // define the listener
        wrappedListenerRegister
        [ rootLessChangePath ]      = function( changeValue, state, verbose = false )
        {
            const changeValueType = typeof( changeValue )

            if ( verbose === true )
            {
                log.debug( 'Relevant path list, parent:', relevantListenerSets.parentListenerSet.path, 'children:', childrensPaths.join( ', ' ) )
            }

            if ( changeValueType === 'object' )
            {
                // if the value is an object, some other paths that the parent listeners
                // are subscribed to might also have changed - but only the paths that
                // are in this tree, so we can suffice with updating the children's paths'
                // caches
                updateChildrensCaches( state )
            }
            else if ( hasChildrenListeners )
            {
                // sanity checking
                throw new Error( `Unacceptable state change: this listener has children, can't push update with primitive` )
            }

            // do necessary cached state updates in parent
            parentCacheUpdateFn( changeValue, state )

            // a (parent)listener can be subscribed to multiple paths
            // here we get the (cached) state for each path
            const lensedSubStates   = parentListenerPaths.reduce(
                ( obj, listenerPath ) =>
                ({
                    [ listenerPath ] : indexedState[ listenerPath ].cache
                    ,   ... obj
                })
                ,   {}
            )

            bundledParentListenerHandlers(
                lensedSubStates
                ,   { path: rootLessChangePath, value: changeValue }
            )

            if ( changeValueType === 'object' )
            {
                // call children listeners
                const lensedChildrenSubStates   = childrenListenerPaths.reduce(
                    ( obj, listenerPaths ) =>
                    ({
                        [ listenerPaths ] : indexedState[ listenerPaths ].cache
                        ,   ... obj
                    })
                    ,   {}
                )

                bundledChildrenListenerHandlers(
                    lensedChildrenSubStates
                    ,   { path: rootLessChangePath, value: changeValue }
                )
            }
        }
    }

    return wrappedListenerRegister
}

const remapListeners                = function( state, listeners, log, noValueDefault )
{
    log.debug( `collective remapListeners` );
    const t = Date.now();
    const   {
        listenableSpace
        ,   listenerObject
        ,   indexedState
    }                               = prepListenerObjects( state.data, listeners, log, noValueDefault )

    const pathToListenerArrayDictionary     = createPathListenerDictionary( listenableSpace, '', listenerObject, [] )

    const pathToWrappedListenerDictionary   = wrapListenerArrays( pathToListenerArrayDictionary, indexedState, log )

    log.debug( `collective remapListeners took ${Date.now() - t}ms` );

    return pathToWrappedListenerDictionary;
}

const createStore = function({ initialState, initialListeners = [], log = console, noValueDefault })
{
    if ( ! initialState )
    {
        throw new Error( 'Listener brain expected an initialState' )
    }

    let     cachedState     = initialState

    const   listenerConfigs = initialListeners

    let     mappedListeners = remapListeners( cachedState, listenerConfigs, log, noValueDefault )

    const remapCurrentListeners = () => {
        mappedListeners = remapListeners( cachedState, listenerConfigs, log, noValueDefault )
    }

    const addListener       = function( listenerConfig, {remap = true} = {} )
    {
        if ( Array.isArray( listenerConfig ))
        {
            return listenerConfig.map( singleListenerConfig => addListener( singleListenerConfig ) )
        }

        listenerConfig.id = uuid()

        listenerConfigs.push( listenerConfig )

        if( remap !== false ) {
            try
            {
                mappedListeners = remapListeners( cachedState, listenerConfigs, log, noValueDefault )
            }
            catch ( err )
            {
                log.error( err )
                throw new Error( `Could not add listener for "${listenerConfig.path}". ${err.message}` )
            }
        }

        return listenerConfig.id
    }

    const removeListener    = function( id )
    {
        const index = listenerConfigs.findIndex( lc => lc.id === id )
        const listenerConfig = listenerConfigs[ index ];

        if ( index === -1 )
        {
            throw new Error( 'No listener with id ' + id + 'defined' )
        }

        listenerConfigs.splice( index, 1 )

        try
        {
            mappedListeners = remapListeners( cachedState, listenerConfigs, log, noValueDefault )
        }
        catch ( err )
        {
            log.error( err )
            throw new Error( `Could not remove listener for "${listenerConfig.path}". ${err.message}` )
        }
    }
    const updateValue = function( path, value ) {
        const state = set( clone( cachedState ), 'data.' + path, value );
        state.lastChange = {
            request: {
                path, value
            }
        };
        return updateState( state, false );
    }

    const updateState       = function( state, forceRemap )
    {
        // log.info( '\nupdateState:')
        // console.log( JSON.stringify( state, null, 2 ) )

        const lsPath = state.lastChange.request.path
        const lsVal = state.lastChange.request.value
        let handler = mappedListeners[ lsPath ]

        // console.log( mappedListeners )

        if ( ! handler || forceRemap )
        {
            if ( ! handler )
            {
                log.info( `Unknown state path "${lsPath}" -> remapping listeners` )
            }
            if ( forceRemap )
            {
                log.info( `Remap enforced!` )
            }

            mappedListeners = remapListeners( state, listenerConfigs, log, noValueDefault )

            if ( mappedListeners[ lsPath ] )
            {
                handler = mappedListeners[ lsPath ]
            }
            else
            {
                return false
            }
        }

        cachedState = state

        handler( lsVal, state )

        return true
    }


    return {
        addListener,
        removeListener,
        updateState,
        updateValue,
        remapCurrentListeners,
        get cachedState()
        {
            return JSON.parse( JSON.stringify( cachedState ))
        }
    }
}


const bundleFns = fnArray =>
      {
          return ( arg1, arg2 = undefined ) =>
          {
              for ( let fn of fnArray )
              {
                  fn( arg1, arg2 )
              }
          }
      }

const buildObjGetter = (pathArr, noValueDefault) =>
      {
          return pathArr.join() === ''
              ? obj => obj
              : obj => get( obj, pathArr, noValueDefault )
      }


export default { createStore, prepListenerObjects,createPathListenerDictionary, remapListeners};
// export createPathListenerDictionary;
// export prepListenerObjects;
// export remapListeners;
