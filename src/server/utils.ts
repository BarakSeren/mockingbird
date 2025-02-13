import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import  { Request, Response, NextFunction, Express } from 'express';
import { graphql, buildSchema } from 'graphql';
import { checkIsProgramActive, readAppSettings, updateAppSettings } from '../backend/utils';
import { GraphQlRoute, LogMetadata, ResponseLog, Route, RouteParent, ServerLog, ServerLogType, ServerSettings } from '../types';
import { EVENT_KEYS } from '../types/events';
import { getGraphqlSchemaFromJsonSchema } from '../utils/jsonToSchema';
import { socketIo } from '../backend/app';
import { serverLogsManager } from '../backend/managers';
const expressPlayground = require('graphql-playground-middleware-express').default;
const toJsonSchema = require('to-json-schema');

const requestsLog:{[key:string]: any} = {}

export const buildProxyUrl = (originUrl:string, req: Request): string=>{
    let url = originUrl;
    Object.entries(req.params).forEach(([key,value])=>{
        url = url.replace(':'+key,value );
    });


    Object.entries(req.query).forEach(([key,value], i)=>{
        if(i === 0){
            url = `${url}?${key}=${value}`
        }else{
            url = `${url}&${key}=${value}`
        }
    });
    return url;
}

export const getSelectedRoute = (req: Request,routeList: Route[]): Route | null=>{
    const params = req.params;
    const query = req.query;
    const body = req.body;

    const selectedRoute = routeList.find((routeItem)=>{
        const { paramKey, paramType, paramValue} = routeItem
        if(!!paramKey && !!paramValue){
            if(paramType === 'body'){
                return body[paramKey] == paramValue;
            } else if(paramType === 'params'){
                return params[paramKey] == paramValue;
            } else if(paramType === 'query'){
                return query[paramKey] == paramValue;
            }
        }
    });

    return selectedRoute || null
}

type HandleResponseProps = {
    host: string;
    serverName: string;
    route: Route;
    req: Request;
    res: Response;
    next: NextFunction;
    serverSettings: ServerSettings
}
export const handleResponse = async ({host, serverName, route, req, res, next, serverSettings}:HandleResponseProps )=>{
    const { activeResponseId, responsesHash } = route;
    try {
        const response = responsesHash?.[activeResponseId];
        if(!response || serverSettings.forceProxy && !response.blockProxy){
            next();
            return;
        }
        if(response.type === 'func' && !!response.exec){
            const func = reviveFunctions('',response.exec);
			updateLog((req as any).id, {logType: 'local', serverName});

            func(req, res);
        }else if(response.type === 'obj'){
            const data = response.res?.data;
            const status = response.res?.code || 500;
            const headers = response.res?.headers || {};

            res = updateResponseHeaders({res, headers, serverSettings});
			updateLog((req as any).id, {logType: 'local', serverName});

            res.status(status).send(data);

        } else if(response.type === 'proxy' && !!response.url){
            let proxyUrl = buildProxyUrl(response.url, req);

            const reqOptions = buildRequestOptions(proxyUrl, req, serverSettings);
			updateLog((req as any).id, {logType: 'proxy', serverName, proxyRequest: reqOptions});

			const proxyRes = await axios(reqOptions);
			const proxyResLog = buildProxyResLog(proxyRes)
			updateLog((req as any).id, { proxyResponse: proxyResLog});

			updateResponseHeaders({res, headers: proxyRes.headers, host, proxyUrl: response.url, serverSettings});
			res.status(proxyRes.status).send(proxyRes.data);

            
          
        }else{
            updateLog((req as any).id, {logType: 'error', serverName});

            res.status(500).send("local response fail");;
        }
    } catch (error: any) {
        console.log('HandleResponse Error',error,route)
        if(!!error?.response){
            res = updateResponseHeaders({res, headers: error?.response.headers, serverSettings});
            updateLog((req as any).id, {logType: 'error', serverName});

            res.status(error?.response.status).send(error?.response.data);
        }else{
            updateLog((req as any).id, {logType: 'error', serverName});

            res.status(500).send("local response fail");;
        }
    }
}

function extractDomain(url: string): string {
    try {
      // Create a new URL object
      const urlObj = new URL(url);
      // Extract the hostname from the URL object
      const hostname = urlObj.hostname;
  
      // Split the hostname by dots
      const parts = hostname.split('.');
      
      // Handle cases like 'co.uk' and return the last two parts for such cases
      if (parts.length > 2) {
        return parts.slice(-2).join('.');
      }
      
      // Return the hostname for normal cases
      return hostname;
    } catch (error) {
      // Handle invalid URL error
      console.error('Invalid URL:', error);
      return '';
    }
  }
  
const rewriteCookieDomain = (setCookieHeaders: string | string[], rewriteRules: {[key: string]: string}) => {
    if (!setCookieHeaders) {
      return setCookieHeaders;
    }
  
    if (!Array.isArray(setCookieHeaders)) {
      setCookieHeaders = [setCookieHeaders];
    }
  
    return setCookieHeaders.map((header) => {
      return header.split(';').map((part) => {

        if (part.trim().toLowerCase().startsWith('domain=')) {
          const domain = part.split('=')[1].trim();
          const newDomain = rewriteRules[domain] || rewriteRules['*'] || domain;

          return `domain=${newDomain}`;
        }
        return part
      }).join(';');
    });
  };

  // Function to extract and simplify cookies
function simplifyCookies(cookieString: string) {
    return cookieString.split(';')[0]; // Take only the cookie name and value, ignoring attributes
  }
  
type UpdateResponseHeadersProps = {
    res: Response;
    headers: {[key: string]: any};
    host?: string;
    proxyUrl?: string;
    serverSettings: ServerSettings;
}

export const updateResponseHeaders = ({res, headers, host, proxyUrl, serverSettings}:UpdateResponseHeadersProps)=>{
    
    if(!!headers && !!res){
        const headersKeys = Object.keys(headers)
        headersKeys.forEach((key)=>{
            if(key === 'set-cookie'){
                let cookies = headers[key];

                if(serverSettings.reWriteCookieDomain && !!host && !!proxyUrl){
                    const rewriteRules = {
                        [extractDomain(proxyUrl)]: host
                    }
                    cookies = rewriteCookieDomain(headers[key], rewriteRules)
                }

                if(serverSettings.simplifyCookies){
                    cookies = cookies.map((ck: string)=>{
                        return simplifyCookies(ck)
                    })
                }
                
                res.setHeader(key, headers[key])
            }else{
                res.setHeader(key, headers[key])
            }
        })
    }

    return res
}

export const updateLog = (id: string, obj: {
    serverName?: string,
    logType?: string,
    proxyResponse?: any,
    proxyRequest?: any,
})=>{
    try {
        requestsLog[id] = {
            ...(requestsLog[id] || {}),
            ...obj
        }
    } catch (error) {
        console.log('updateLog error', error)
    }
}

export const getLog = (id: string)=>{
    return requestsLog[id];
}



export const buildRequestOptions = (proxyUrl:string, req: Request, serverSettings: ServerSettings): AxiosRequestConfig=>{
    const method = req.method.toLowerCase() as Method;

    const headersKeys = Object.keys(req.headers);
    const requestOptions:AxiosRequestConfig = {
        method: method,
        url:proxyUrl,
        headers: 
        {
            ...headersKeys.reduce((acc, key)=>{
                if(!!key){
                    if(key === 'cookie'){
                        if(serverSettings.duplicateCookies){
                            acc[key] = req.get(key) +';'+req.get(key) 

                        }else{
                            acc[key] = req.get(key)
                        }
                    }else{
                        acc[key] = req.get(key) 
                    }
                }

                return acc;
            }, {} as {[key:string]: any}),
        }
    }
    if(['put','patch','post'].includes(method)){
        requestOptions.data = req.body
    }
    delete requestOptions?.headers?.['host'];
    return requestOptions
}

export const sendLog = (projectName: string, req: Request, res: ResponseLog, metadata: LogMetadata, proxy: any)=>{
    const url = req.originalUrl;
    const params = req.params;
    const query = req.query;
    const body = req.body;
    const headers = req.headers;
    const method = req.method;
    const ip = req.ip || '';
    const protocol = req.protocol;
    const route = req.route ? req.route.path : '';

    const log: ServerLog  = {
        metadata,
        request: {
            url,
            params,
            query,
            body,
            headers,
            method,
            ip,
            protocol,
            route,
        },
        response: res,
        proxy,
        timestamp: (new Date()).getTime()
    }  
    serverLogsManager.addLog(projectName, log)
    socketIo.emit(EVENT_KEYS.SERVER_LOGGER, {log})
}


export const buildProxyResLog = (res: ResponseLog)=>{
    const response = {
        headers: res.headers,
        status: res.status,
        data: res.data
    }
    return response
}

export const addMinutes = (date: Date, minutes: number) => {
    return new Date(date.getTime() + minutes * 60000);
}

export const handleServerActivationLimit = async (onLimitActivate: (serverDisabledUntil: Date)=> void)=>{
    const appSettings = await readAppSettings();
	const isProgramActive = await checkIsProgramActive()

	if(!isProgramActive){
		const serverEndTime = addMinutes(new Date(), appSettings.activeTime)
		if(!!appSettings.serverEndTime && serverEndTime.getTime() > new Date(appSettings.serverEndTime).getTime()){
			await updateAppSettings({
				...appSettings,
				serverEndTime
			})
		}

		const closeServerInterval = setInterval(()=>{
			const currentTime = new Date();
			if(currentTime.getTime() > serverEndTime.getTime()){
				clearInterval(closeServerInterval)
				const serverDisabledUntil = addMinutes(new Date(), appSettings.disableTime)
				updateAppSettings({
					...appSettings,
					serverDisabledUntil,
				})
                if(onLimitActivate){
                    onLimitActivate(serverDisabledUntil)
                }
			}
		},3000)
	}
}

function extractFunctionName(input: string): string {
    const functionNameRegex = /^([a-zA-Z0-9]+)/;
    const match = input.match(functionNameRegex);
    if (match && match[1]) {
        return match[1];
    } else {
        throw new Error("Invalid input format. Expected format: functionName(arguments) or just functionName");
    }
}

export const handleGraphqlResponse = (serverName: string, route: GraphQlRoute, serverSettings: ServerSettings)=>{
    const resolverName = extractFunctionName(route.name);

    return {
        [resolverName]: async (args: any, context: any, info: any)=>{
            const {req, res} = context;

            try {
                const response = route.responsesHash?.[route.activeResponseId]
                if(response?.type === 'func'){
                    const func = reviveFunctions('',response?.exec);
                    updateLog(req.id, {logType: 'local', serverName});

                    return func(args, context, info)
                }else if(response?.type === 'obj'){
                    updateLog(req.id, {logType: 'local', serverName});
                    return response.res;
                } else if(response?.type === 'proxy'){

                    const reqOptions = buildRequestOptions(response.url || '', req, serverSettings);
                    updateLog(req.id, {logType: 'proxy', proxyRequest:reqOptions});

                    const proxyRes = await axios(reqOptions);
                    updateResponseHeaders({res, headers: proxyRes.headers, serverSettings});
			        const proxyResLog = buildProxyResLog(proxyRes)

                    updateLog(req.id, {proxyResponse: proxyResLog});

                    return proxyRes.data;
                }
            } catch (error) {
                updateLog(req.id, {logType: 'error', serverName});

                throw error;
            }
          
        }
    }
}

function createNestedObject(path: string, payload: {[key:string]: string}): Record<string, any> {
    const keys = path.split('.');
    const result: Record<string, any> = {};

    let currentObj = result;

    for (let i = 0; i < keys.length - 1; i++) {
        currentObj[keys[i]] = {};
        currentObj = currentObj[keys[i]];
    }

    currentObj[keys[keys.length - 1]] = payload;

    return result;
}

export function mergeObjects(objects: Record<string, any>[]): Record<string, any> {
    const result: Record<string, any> = {};

    for (const obj of objects) {
        mergeObjectsRecursive(result, obj);
    }

    return result;
}

function mergeObjectsRecursive(target: Record<string, any>, source: Record<string, any>) {
    for (const key in source) {
        if (source.hasOwnProperty(key)) {
            if (typeof source[key] === 'object' && !Array.isArray(source[key])) {
                target[key] = target[key] || {};
                mergeObjectsRecursive(target[key], source[key]);
            } else {
                target[key] = source[key];
            }
        }
    }
}


export const buildGraphQLData = (serverName: string, parents: RouteParent[], serverSettings: ServerSettings)=>{
    const routes = parents.reduce((acc, item)=>{
        return [...acc, ...Object.values(item.graphQlRouteHash || {})]
    },[] as GraphQlRoute[]);

    const {queries, mutations} =  routes.reduce((acc, item)=>{
		if(item.type === 'Mutation'){
			acc.mutations.push(item)
		}else if (item.type === 'Query'){
			acc.queries.push(item)
		}
		return acc
	},{queries:[], mutations:[]} as {queries: GraphQlRoute[], mutations: GraphQlRoute[]})

    let schemaStr = `
	    scalar Any
  	`;

    const {
        queryObjArr,
        mutationObjArr,
        queryResolverObjArr,
        mutationResolverObjArr
    } = parents.reduce((acc, item)=>{
        const _routes = Object.values(item.graphQlRouteHash || {});

        if(_routes.some((_route)=>_route.type === 'Mutation')){

            const mutations = Object.values(item.graphQlRouteHash || {}).reduce((acc, _item)=>{
                if(_item.type === 'Mutation' && _item.responsesHash?.[_item.activeResponseId]){
                    acc.schema[_item.responsesHash[_item.activeResponseId].schemaTypeName] = ""
                    acc.resolver = {
                        ...acc.resolver,
                        ...handleGraphqlResponse(serverName,_item, serverSettings)
                    }
                }
                return acc
            },{schema:{}, resolver:{}} as {schema: {[key:string]: string} , resolver: {[key:string]: any} })

            if(Object.keys(mutations).length > 0){
                if(!!item.schemaPath && item.schemaPath?.length > 0){
                    acc.mutationObjArr.push(createNestedObject(item.schemaPath, mutations.schema))
                    acc.queryResolverObjArr.push(createNestedObject(item.schemaPath, mutations.resolver))
                }else{
                    acc.mutationObjArr.push(mutations.schema)
                    acc.queryResolverObjArr.push(mutations.resolver)
                }
            }
        }

        if(_routes.some((_route)=>_route.type === 'Query')){

            const queries = Object.values(item.graphQlRouteHash || {}).reduce((acc, _item)=>{
                if(_item.type === 'Query' && _item.responsesHash?.[_item.activeResponseId]){
                    acc.schema[_item.responsesHash[_item.activeResponseId].schemaTypeName] = ""
                    acc.resolver = {
                        ...acc.resolver,
                        ...handleGraphqlResponse(serverName,_item, serverSettings)
                    }
                }
                return acc
            },{schema:{}, resolver:{}} as {schema: {[key:string]: string} , resolver: {[key:string]: any} });

            if(Object.keys(queries).length > 0){
                if(!!item.schemaPath && item.schemaPath?.length > 0){
                    acc.queryObjArr.push(createNestedObject(item.schemaPath, queries.schema))
                    acc.mutationResolverObjArr.push(createNestedObject(item.schemaPath, queries.resolver))
                }else{
                    acc.queryObjArr.push(queries.schema)
                    acc.mutationResolverObjArr.push(queries.resolver)
                }
            }
        }

        return acc
    }, {
        queryObjArr: [],
        mutationObjArr:[],
        queryResolverObjArr: [],
        mutationResolverObjArr: []
    } as {
        queryObjArr: Record<string, any>[],
        mutationObjArr: Record<string, any>[],
        queryResolverObjArr: Record<string, any>[],
        mutationResolverObjArr: Record<string, any>[],
    })
    

    if(queryObjArr.length > 0){
        const queryObjArrCombined = mergeObjects(queryObjArr);

        const querySchemaArr = getGraphqlSchemaFromJsonSchema({rootName: 'rootQ', schema: toJsonSchema(queryObjArrCombined), direction:'output'})
        
        querySchemaArr.typeDefinitions[querySchemaArr.typeDefinitions.length -1] = querySchemaArr.typeDefinitions[querySchemaArr.typeDefinitions.length -1].replace(querySchemaArr.typeName,'Query')
        let queryTypes = querySchemaArr.typeDefinitions.join('\n');

        queryTypes = queries.reduce((acc, query)=>{
            const response = query.responsesHash?.[query.activeResponseId]
            if(!response){
                return acc;
            }
            let queryName =  query.name + ': '+ response.schemaTypeName;
            return acc.replace(response.schemaTypeName+': String', queryName)
        }, queryTypes);

        schemaStr += `
            ${queryTypes}
        `
    }

    if(mutationObjArr.length > 0){
        const mutationObjArrCombined = mergeObjects(mutationObjArr);

        const mutationSchemaArr = getGraphqlSchemaFromJsonSchema({rootName: 'rootM', schema: toJsonSchema(mutationObjArrCombined), direction:'output'});

        mutationSchemaArr.typeDefinitions[mutationSchemaArr.typeDefinitions.length -1] = mutationSchemaArr.typeDefinitions[mutationSchemaArr.typeDefinitions.length -1].replace(mutationSchemaArr.typeName,'Mutation')

        let mutationTypes = mutationSchemaArr.typeDefinitions.join('\n');

        mutationTypes = mutations.reduce((acc, query)=>{
            const response = query.responsesHash?.[query.activeResponseId]
            if(!response){
                return acc;
            }
            return acc.replace(response.schemaTypeName+': String', '' + query.name + ': '+ response.schemaTypeName)
        }, mutationTypes)

        schemaStr = `
            ${schemaStr}
            ${mutationTypes}
        `
    }
    

    const queryResolversCombined = mergeObjects(queryResolverObjArr);
    const mutationResolversCombined = mergeObjects(mutationResolverObjArr);

    const responseTypes = routes.reduce((acc, item)=>{
        acc += `${item.responsesHash?.[item.activeResponseId]?.schema || ''}\n`
        return acc;
    },'')

    schemaStr += `
        ${responseTypes}
    `

    const schema = buildSchema(schemaStr)

	const root = {
		...queryResolversCombined,
        ...mutationResolversCombined
	};


    return {schema, root}
}

export const handleGraphQlRoutes = (app: Express, serverName: string, graphQlParents: RouteParent[], serverSettings: ServerSettings)=>{

	if(graphQlParents.length > 0){
		const graphQlParentsByPath = graphQlParents.reduce((acc, item)=>{
			if(!acc[item.path]){
				acc[item.path] = [item]
			}else{
				acc[item.path].push(item)
			}
			return acc;
		},{} as {[key:string]: RouteParent[]})

		Object.keys(graphQlParentsByPath).forEach((parentsPath)=>{
			const parents = graphQlParentsByPath[parentsPath];
			const playgroundPath = parentsPath+'/playground'

            try {
                const {root, schema} = buildGraphQLData(serverName,parents, serverSettings);
        
                app.use(parentsPath, async (req,res,next)=>{
                    try {
                        if(req.originalUrl === playgroundPath){
                            next();
                            return;
                        }

                        const variablesExists = Object.keys(req.body?.variables || {}).length > 0
                        const response = await graphql({
                            schema,
                            source: req.body.query,
                            variableValues: variablesExists ? req.body.variables :{},
                            rootValue: root,
                            contextValue: { res, req }
                        })
                        
                        if (response.errors) {
                            response.errors.forEach(({message})=>console.log('graphql error: ',message))
                            // if query not exist need to send to proxy
                            if(response.errors.some((err)=>err.message.includes('Cannot query field') || err.message.includes('Query root type must be provided'))){
                                next()
                                return; 
                            }
                        } 
                        res.status(200).send(response);
                    } catch (error) {
                        console.log('---error', error)
                        next();
                    }
                });
            } catch (error) {
                console.log('-----error gql', error)
                // mainWindow?.webContents.send("debugLog", {success:false, error})
                throw error
            }
			app.get(playgroundPath, expressPlayground({ endpoint: parentsPath }));
		})

	}
}

export const reviveFunctions = (key:string, value: any) => {
    try {
        const _value = value.trim();

        const func =  eval('(' + _value + ')');
    
        return func
    } catch (error) {
      throw new Error('fail to revive function');
    }
  }