var Helpers = require('./helpers'),
    Constants = require('./constants'),
    ServerModel = require('./serverModel'),
    Forwarders = require('./forwarders'),
    Persistence = require('./persistence'),
    Types = require('./types'),
    Messages = Constants.Messages,
    MP = require('./mp'),
    Validators = Helpers.Validators,
    send = require('./events').send,
    CookieSyncManager = require('./cookieSyncManager'),
    Events = require('./events');

var Identity = {
    checkIdentitySwap: function(previousMPID, currentMPID) {
        if (previousMPID && currentMPID && previousMPID !== currentMPID) {
            var cookies = Persistence.useLocalStorage() ? Persistence.getLocalStorage() : Persistence.getCookie();
            Persistence.storeDataInMemory(cookies, currentMPID);
            Persistence.update();
        }
    }
};

var IdentityRequest = {
    createKnownIdentities: function(identityApiData, deviceId) {
        var identitiesResult = {};

        if (identityApiData && identityApiData.userIdentities && Helpers.isObject(identityApiData.userIdentities)) {
            for (var identity in identityApiData.userIdentities) {
                identitiesResult[identity] = identityApiData.userIdentities[identity];
            }
        }
        identitiesResult.device_application_stamp = deviceId;

        return identitiesResult;
    },

    preProcessIdentityRequest: function(identityApiData, callback, method) {
        Helpers.logDebug(Messages.InformationMessages.StartingLogEvent + ': ' + method);

        var identityValidationResult = Validators.validateIdentities(identityApiData, method);

        if (!identityValidationResult.valid) {
            Helpers.logDebug('ERROR: ' + identityValidationResult.error);
            return {
                valid: false,
                error: identityValidationResult.error
            };
        }

        if (callback && !Validators.isFunction(callback)) {
            Helpers.logDebug('The optional callback must be a function. You tried entering a(n) ' + typeof fn);
            return {
                valid: false,
                error: 'The optional callback must be a function. You tried entering a(n) ' + typeof fn
            };
        }

        if (identityValidationResult.warning) {
            Helpers.logDebug('WARNING:' + identityValidationResult.warning);
            return {
                valid: true,
                error: identityValidationResult.warning
            };
        }

        return {
            valid: true
        };
    },

    createIdentityRequest: function(identityApiData, platform, sdkVendor, sdkVersion, deviceId, context, mpid) {
        var APIRequest = {
            client_sdk: {
                platform: platform,
                sdk_vendor: sdkVendor,
                sdk_version: sdkVersion
            },
            context: context,
            environment: mParticle.isDevelopmentMode ? 'development' : 'production',
            request_id: Helpers.generateUniqueId(),
            request_timestamp_ms: new Date().getTime(),
            previous_mpid: mpid || null,
            known_identities: this.createKnownIdentities(identityApiData, deviceId)
        };

        return APIRequest;
    },

    createModifyIdentityRequest: function(currentUserIdentities, newUserIdentities, platform, sdkVendor, sdkVersion, context) {
        return {
            client_sdk: {
                platform: platform,
                sdk_vendor: sdkVendor,
                sdk_version: sdkVersion
            },
            context: context,
            environment: mParticle.isDevelopmentMode ? 'development' : 'production',
            request_id: Helpers.generateUniqueId(),
            request_timestamp_ms: new Date().getTime(),
            identity_changes: this.createIdentityChanges(currentUserIdentities, newUserIdentities)
        };
    },

    createIdentityChanges: function(previousIdentities, newIdentities) {
        var identityChanges = [];
        var key;
        if (newIdentities && Helpers.isObject(newIdentities) && previousIdentities && Helpers.isObject(previousIdentities)) {
            for (key in newIdentities) {
                identityChanges.push({
                    old_value: previousIdentities[Types.IdentityType.getIdentityType(key)] || null,
                    new_value: newIdentities[key],
                    identity_type: key
                });
            }
        }

        return identityChanges;
    },

    modifyUserIdentities: function(previousUserIdentities, newUserIdentities) {
        var modifiedUserIdentities = {};

        for (var key in newUserIdentities) {
            modifiedUserIdentities[Types.IdentityType.getIdentityType(key)] = newUserIdentities[key];
        }

        for (key in previousUserIdentities) {
            if (!modifiedUserIdentities[key]) {
                modifiedUserIdentities[key] = previousUserIdentities[key];
            }
        }

        return modifiedUserIdentities;
    }
};

var IdentityAPI = {
    logout: function(identityApiData, callback) {
        var preProcessResult = IdentityRequest.preProcessIdentityRequest(identityApiData, callback, 'logout');

        if (preProcessResult.valid) {
            var evt,
                identityApiRequest = IdentityRequest.createIdentityRequest(identityApiData, Constants.platform, Constants.sdkVendor, Constants.sdkVersion, MP.deviceId, MP.context, MP.mpid);

            if (Helpers.canLog()) {
                if (!Helpers.tryNativeSdk(Constants.NativeSdkPaths.Logout)) {
                    sendIdentityRequest(identityApiRequest, 'logout', callback, identityApiData);
                    evt = ServerModel.createEventObject(Types.MessageType.Profile);
                    evt.ProfileMessageType = Types.ProfileMessageType.Logout;

                    if (MP.forwarders.length) {
                        MP.forwarders.forEach(function(forwarder) {
                            if (forwarder.logOut) {
                                forwarder.logOut(evt);
                            }
                        });
                    }
                }
            }
            else {
                Helpers.logDebug(Messages.InformationMessages.AbandonLogEvent);
            }
        } else {
            if (Validators.isFunction(callback)) {
                callback(preProcessResult);
            } else {
                Helpers.logDebug(preProcessResult);
            }
        }
    },
    login: function(identityApiData, callback) {
        var preProcessResult = IdentityRequest.preProcessIdentityRequest(identityApiData, callback, 'login');

        if (preProcessResult.valid) {
            var identityApiRequest = IdentityRequest.createIdentityRequest(identityApiData, Constants.platform, Constants.sdkVendor, Constants.sdkVersion, MP.deviceId, MP.context, MP.mpid);

            if (Helpers.canLog()) {
                if (!Helpers.tryNativeSdk(Constants.NativeSdkPaths.Login)) {
                    sendIdentityRequest(identityApiRequest, 'login', callback, identityApiData);
                }
            }
            else {
                Helpers.logDebug(Messages.InformationMessages.AbandonLogEvent);
            }
        } else {
            if (Validators.isFunction(callback)) {
                callback(preProcessResult);
            } else {
                Helpers.logDebug(preProcessResult);
            }
        }
    },
    modify: function(identityApiData, callback) {
        var newUserIdentities = (identityApiData && identityApiData.userIdentities) ? identityApiData.userIdentities : {};
        var preProcessResult = IdentityRequest.preProcessIdentityRequest(identityApiData, callback, 'modify');
        if (preProcessResult.valid) {
            var identityApiRequest = IdentityRequest.createModifyIdentityRequest(MP.userIdentities, newUserIdentities, Constants.platform, Constants.sdkVendor, Constants.sdkVersion, MP.context);

            if (Helpers.canLog()) {
                if (!Helpers.tryNativeSdk(Constants.NativeSdkPaths.Modify)) {
                    sendIdentityRequest(identityApiRequest, 'modify', callback, identityApiData);
                }
            }
            else {
                Helpers.logDebug(Messages.InformationMessages.AbandonLogEvent);
            }
        } else {
            if (Validators.isFunction(callback)) {
                callback(preProcessResult);
            } else {
                Helpers.logDebug(preProcessResult);
            }
        }
    },
    getCurrentUser: function() {
        var mpid = MP.mpid.slice();
        return mParticleUser(mpid);
    }
};

function mParticleUser(mpid) {
    return {
        getUserIdentities: function() {
            var currentUserIdentities = {};

            var identities = Persistence.getUserIdentities(mpid);

            for (var identityType in identities) {
                if (identities.hasOwnProperty(identityType)) {
                    currentUserIdentities[Types.IdentityType.getIdentityName(Helpers.parseNumber(identityType))] = identities[identityType];
                }
            }

            return {
                userIdentities: currentUserIdentities
            };
        },
        getMPID: function() {
            return mpid;
        },
        setUserTag: function(tagName) {
            mParticle.sessionManager.resetSessionTimer();

            if (!Validators.isValidKeyValue(tagName)) {
                Helpers.logDebug(Messages.ErrorMessages.BadKey);
                return;
            }

            this.setUserAttribute(tagName, null);
        },
        removeUserTag: function(tagName) {
            mParticle.sessionManager.resetSessionTimer();

            if (!Validators.isValidKeyValue(tagName)) {
                Helpers.logDebug(Messages.ErrorMessages.BadKey);
                return;
            }

            this.removeUserAttribute(tagName);
        },
        setUserAttribute: function(key, value) {
            var cookies,
                userAttributes;

            mParticle.sessionManager.resetSessionTimer();

            if (Helpers.canLog()) {
                if (!Validators.isValidAttributeValue(value)) {
                    Helpers.logDebug(Messages.ErrorMessages.BadAttribute);
                    return;
                }

                if (!Validators.isValidKeyValue(key)) {
                    Helpers.logDebug(Messages.ErrorMessages.BadKey);
                    return;
                }

                cookies = Persistence.getPersistence();

                userAttributes = this.getAllUserAttributes();

                var existingProp = Helpers.findKeyInObject(userAttributes, key);

                if (existingProp) {
                    delete userAttributes[existingProp];
                }

                userAttributes[key] = value;
                cookies[mpid].ua = userAttributes;
                Persistence.updateOnlyCookieUserAttributes(cookies, mpid);
                Persistence.storeDataInMemory(cookies, mpid);

                if (!Helpers.tryNativeSdk(Constants.NativeSdkPaths.SetUserAttribute, JSON.stringify({ key: key, value: value }))) {
                    Forwarders.callSetUserAttributeOnForwarders(key, value);
                }
            }
        },
        removeUserAttribute: function(key) {
            var cookies, userAttributes;
            mParticle.sessionManager.resetSessionTimer();

            if (!Validators.isValidKeyValue(key)) {
                Helpers.logDebug(Messages.ErrorMessages.BadKey);
                return;
            }

            cookies = Persistence.getPersistence();

            userAttributes = this.getAllUserAttributes();

            var existingProp = Helpers.findKeyInObject(userAttributes, key);

            if (existingProp) {
                key = existingProp;
            }

            delete userAttributes[key];

            cookies[mpid].ua = userAttributes;
            Persistence.updateOnlyCookieUserAttributes(cookies, mpid);
            Persistence.storeDataInMemory(cookies, mpid);

            if (!Helpers.tryNativeSdk(Constants.NativeSdkPaths.RemoveUserAttribute, JSON.stringify({ key: key, value: null }))) {
                Forwarders.applyToForwarders('removeUserAttribute', key);
            }
        },
        setUserAttributeList: function(key, value) {
            var cookies, userAttributes;

            mParticle.sessionManager.resetSessionTimer();

            if (!Validators.isValidKeyValue(key)) {
                Helpers.logDebug(Messages.ErrorMessages.BadKey);
                return;
            }

            if (!Array.isArray(value)) {
                Helpers.logDebug('The value you passed in to setUserAttributeList must be an array. You passed in a ' + typeof value);
                return;
            }

            var arrayCopy = value.slice();

            cookies = Persistence.getPersistence();

            userAttributes = this.getAllUserAttributes();

            var existingProp = Helpers.findKeyInObject(userAttributes, key);

            if (existingProp) {
                delete userAttributes[existingProp];
            }

            userAttributes[key] = arrayCopy;
            cookies[mpid].ua = userAttributes;
            Persistence.updateOnlyCookieUserAttributes(cookies, mpid);
            Persistence.storeDataInMemory(cookies, mpid);

            if (!Helpers.tryNativeSdk(Constants.NativeSdkPaths.SetUserAttributeList, JSON.stringify({ key: key, value: arrayCopy }))) {
                Forwarders.callSetUserAttributeOnForwarders(key, arrayCopy);
            }
        },
        removeAllUserAttributes: function() {
            var cookies, userAttributes;

            mParticle.sessionManager.resetSessionTimer();

            cookies = Persistence.getPersistence();

            userAttributes = this.getAllUserAttributes();

            if (!Helpers.tryNativeSdk(Constants.NativeSdkPaths.RemoveAllUserAttributes)) {
                if (userAttributes) {
                    for (var prop in userAttributes) {
                        if (userAttributes.hasOwnProperty(prop)) {
                            Forwarders.applyToForwarders('removeUserAttribute', userAttributes[prop]);
                        }
                    }
                }
            }

            cookies[mpid].ua = {};
            Persistence.updateOnlyCookieUserAttributes(cookies, mpid);
            Persistence.storeDataInMemory(cookies, mpid);
        },
        getUserAttributesLists: function() {
            var userAttributes,
                userAttributesLists = {};

            userAttributes = this.getAllUserAttributes();
            for (var key in userAttributes) {
                if (userAttributes.hasOwnProperty(key) && Array.isArray(userAttributes[key])) {
                    userAttributesLists[key] = userAttributes[key].slice();
                }
            }

            return userAttributesLists;
        },
        getAllUserAttributes: function() {
            var userAttributesCopy = {};
            var userAttributes = Persistence.getAllUserAttributes(mpid);

            if (userAttributes) {
                for (var prop in userAttributes) {
                    if (userAttributes.hasOwnProperty(prop)) {
                        if (Array.isArray(userAttributes[prop])) {
                            userAttributesCopy[prop] = userAttributes[prop].slice();
                        }
                        else {
                            userAttributesCopy[prop] = userAttributes[prop];
                        }
                    }
                }
            }

            return userAttributesCopy;
        },
        getCart: function() {
            return mParticleUserCart(mpid);
        }
    };
}

function mParticleUserCart(mpid){
    return {
        add: function(product, logEvent) {mParticle.sessionManager.resetSessionTimer();
            var allProducts,
                userProducts,
                arrayCopy;

            product.Attributes = Helpers.sanitizeAttributes(product.Attributes);
            arrayCopy = Array.isArray(product) ? product.slice() : [product];

            mParticle.sessionManager.resetSessionTimer();

            allProducts = JSON.parse(Persistence.getLocalStorageProducts());

            if (allProducts && !allProducts[mpid]) {
                allProducts[mpid] = {};
            }

            if (allProducts[mpid].cp) {
                userProducts = allProducts[mpid].cp;
            } else {
                userProducts = [];
            }

            userProducts = userProducts.concat(arrayCopy);

            if (Helpers.isWebViewEmbedded()) {
                Helpers.tryNativeSdk(Constants.NativeSdkPaths.AddToCart, JSON.stringify(arrayCopy));
            }
            else if (logEvent === true) {
                Events.logProductActionEvent(Types.ProductActionType.AddToCart, arrayCopy);
            }

            var productsForMemory = {};
            productsForMemory[mpid] = {cp: userProducts};
            if (mpid === MP.mpid) {
                Persistence.storeProductsInMemory(productsForMemory, mpid);
            }

            if (userProducts.length > mParticle.maxProducts) {
                Helpers.logDebug('The cart contains ' + userProducts.length + ' items. Only mParticle.maxProducts = ' + mParticle.maxProducts + ' can currently be saved in cookies.');
                userProducts = userProducts.slice(0, mParticle.maxProducts);
            }

            allProducts[mpid].cp = userProducts;

            Persistence.setCartProducts(allProducts);
        },
        remove: function(product, logEvent) {
            mParticle.sessionManager.resetSessionTimer();
            var allProducts,
                userProducts,
                cartIndex = -1,
                cartItem = null;

            allProducts = JSON.parse(Persistence.getLocalStorageProducts());

            if (allProducts && allProducts[mpid].cp) {
                userProducts = allProducts[mpid].cp;
            } else {
                userProducts = [];
            }

            if (userProducts) {
                userProducts.forEach(function(cartProduct, i) {
                    if (cartProduct.Sku === product.Sku) {
                        cartIndex = i;
                        cartItem = cartProduct;
                    }
                });

                if (cartIndex > -1) {
                    userProducts.splice(cartIndex, 1);

                    if (Helpers.isWebViewEmbedded()) {
                        Helpers.tryNativeSdk(Constants.NativeSdkPaths.RemoveFromCart, JSON.stringify(cartItem));
                    }
                    else if (logEvent === true) {
                        Events.logProductActionEvent(Types.ProductActionType.RemoveFromCart, cartItem);
                    }
                }
            }

            var productsForMemory = {};
            productsForMemory[mpid] = {cp: userProducts};
            if (mpid === MP.mpid) {
                Persistence.storeProductsInMemory(productsForMemory, mpid);
            }

            allProducts[mpid].cp = userProducts;

            Persistence.setCartProducts(allProducts);
        },
        clear: function() {
            mParticle.sessionManager.resetSessionTimer();
            var allProducts = JSON.parse(Persistence.getLocalStorageProducts());

            if (allProducts && allProducts[mpid].cp) {
                allProducts[mpid].cp = [];

                allProducts[mpid].cp = [];
                if (mpid === MP.mpid) {
                    Persistence.storeProductsInMemory(allProducts, mpid);
                }

                Persistence.setCartProducts(allProducts);
                Helpers.tryNativeSdk(Constants.NativeSdkPaths.ClearCart);
            }
        },
        getCartProducts: function() {
            return Persistence.getCartProducts(mpid);
        }
    };
}

function identify(identityApiData) {
    var preProcessResult = IdentityRequest.preProcessIdentityRequest(identityApiData, MP.identityCallback, 'identify');
    if (preProcessResult.valid) {
        var identityApiRequest = IdentityRequest.createIdentityRequest(identityApiData, Constants.platform, Constants.sdkVendor, Constants.sdkVersion, MP.deviceId, MP.context, MP.mpid);

        sendIdentityRequest(identityApiRequest, 'identify', MP.identityCallback, identityApiData);
    } else {
        if (MP.identityCallback) {
            MP.identityCallback(preProcessResult);
        }
    }
}

function sendIdentityRequest(identityApiRequest, method, callback, originalIdentityApiData) {
    var xhr, previousMPID,
        xhrCallback = function() {
            if (xhr.readyState === 4) {
                Helpers.logDebug('Received ' + xhr.statusText + ' from server');
                parseIdentityResponse(xhr, previousMPID, callback, originalIdentityApiData, method);
            }
        };

    Helpers.logDebug(Messages.InformationMessages.SendIdentityBegin);

    if (!identityApiRequest) {
        Helpers.logDebug(Messages.ErrorMessages.APIRequestEmpty);
        return;
    }

    Helpers.logDebug(Messages.InformationMessages.SendIdentityHttp);
    xhr = Helpers.createXHR(xhrCallback);

    if (xhr) {
        try {
            if (!MP.identityCallInFlight) {
                previousMPID = (!MP.isFirstRun && MP.mpid) ? MP.mpid : null;
                if (method === 'modify') {
                    xhr.open('post', Constants.identityUrl + MP.mpid + '/' + method);
                } else {
                    xhr.open('post', Constants.identityUrl + method);
                }
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.setRequestHeader('x-mp-key', MP.devToken);
                MP.identityCallInFlight = true;
                xhr.send(JSON.stringify(identityApiRequest));
            } else {
                callback({httpCode: -2, body: 'There is currently an AJAX request processing. Please wait for this to return before requesting again'});
            }
        }
        catch (e) {
            MP.identityCallInFlight = false;
            if (callback) {
                callback({httpCode: -1, body: e});
            }
            Helpers.logDebug('Error sending identity request to servers with status code . ' + xhr.status + ' - ' + e);
        }
    }
}

function parseIdentityResponse(xhr, previousMPID, callback, identityApiData, method) {
    var prevUser,
        newUser,
        identityApiResult;
    if (MP.mpid) {
        prevUser = mParticle.Identity.getCurrentUser();
    }

    MP.identityCallInFlight = false;
    try {
        Helpers.logDebug('Parsing identity response from server');
        if (xhr.responseText) {
            identityApiResult = JSON.parse(xhr.responseText);
        }

        if (xhr.status === 200) {
            if (method === 'modify') {
                MP.userIdentities = IdentityRequest.modifyUserIdentities(MP.userIdentities, identityApiData.userIdentities);
                Persistence.update();
            } else {
                identityApiResult = JSON.parse(xhr.responseText);

                Helpers.logDebug('Successfully parsed Identity Response');
                if (identityApiResult.mpid && identityApiResult.mpid !== MP.mpid) {
                    MP.mpid = identityApiResult.mpid;

                    checkCookieForMPID(MP.mpid);
                }

                if (MP.sessionId && MP.mpid && previousMPID !== MP.mpid && MP.currentSessionMPIDs.indexOf(MP.mpid) < 0) {
                    MP.currentSessionMPIDs.push(MP.mpid);
                    // need to update currentSessionMPIDs in memory before checkingIdentitySwap otherwise previous obj.currentSessionMPIDs is used in checkIdentitySwap's Persistence.update()
                    Persistence.update();
                }

                CookieSyncManager.attemptCookieSync(previousMPID, MP.mpid);

                Identity.checkIdentitySwap(previousMPID, MP.mpid);

                // events exist in the eventQueue because they were triggered when the identityAPI request was in flight
                // once API request returns, eventQueue items are reassigned with the returned MPID and flushed
                if (MP.eventQueue.length && MP.mpid !==0) {
                    MP.eventQueue.forEach(function(event) {
                        event.MPID = MP.mpid;
                        send(event);
                    });
                    MP.eventQueue = [];
                }

                //if there is any previous migration data
                if (Object.keys(MP.migrationData).length) {
                    MP.userIdentities = MP.migrationData.userIdentities || {};
                    MP.userAttributes = MP.migrationData.userAttributes || {};
                    MP.cookieSyncDates = MP.migrationData.cookieSyncDates || {};
                } else {
                    if (identityApiData && identityApiData.userIdentities && Object.keys(identityApiData.userIdentities).length) {
                        MP.userIdentities = IdentityRequest.modifyUserIdentities(MP.userIdentities, identityApiData.userIdentities);
                    }
                }
                Persistence.update();
                Persistence.findPrevCookiesBasedOnUI(identityApiData);

                MP.context = identityApiResult.context || MP.context;
            }

            if (identityApiData && identityApiData.onUserAlias && Validators.isFunction(identityApiData.onUserAlias)) {
                newUser = mParticle.Identity.getCurrentUser();
                try {
                    identityApiData.onUserAlias(prevUser, newUser);
                }
                catch (e) {
                    Helpers.logDebug('There was an error with your onUserAlias function - ' + e);
                }
            }
            var cookies = Persistence.getCookie() || Persistence.getLocalStorage();

            if (newUser) {
                Persistence.storeDataInMemory(cookies, newUser.getMPID());
            }

            if (identityApiData && identityApiData.userIdentities) {
                Forwarders.setForwarderUserIdentities(identityApiData.userIdentities);
            }
        }

        if (callback) {
            callback({httpCode: xhr.status, body: identityApiResult || null});
        } else {
            if (identityApiResult && identityApiResult.errors && identityApiResult.errors.length) {
                Helpers.logDebug('Received HTTP response code of ' + xhr.status + ' - ' + identityApiResult.errors[0].message);
            }
        }
    }
    catch (e) {
        if (callback) {
            callback({httpCode: xhr.status, body: identityApiResult});
        }
        Helpers.logDebug('Error parsing JSON response from Identity server: ' + e);
    }
}

function checkCookieForMPID(currentMPID) {
    var cookies = Persistence.getCookie() || Persistence.getLocalStorage();
    if (cookies && !cookies[currentMPID]) {
        Persistence.storeDataInMemory(null, currentMPID);
        MP.cartProducts = [];
        MP.productBags = {};
    } else if (cookies) {
        var products = Persistence.decodeProducts();
        if (products && products[currentMPID]) {
            MP.cartProducts = products[currentMPID].cp;
            MP.productBags = products[currentMPID].pb;
        }
        MP.userIdentities = cookies[currentMPID].ui ? cookies[currentMPID].ui : MP.userIdentities;
        MP.userAttributes = cookies[currentMPID].ua ? cookies[currentMPID].ua : MP.userAttributes;
        MP.cookieSyncDates = cookies[currentMPID].csd ? cookies[currentMPID].csd : MP.cookieSyncDates;
    }

}

module.exports = {
    identify: identify,
    IdentityAPI: IdentityAPI,
    Identity: Identity,
    IdentityRequest: IdentityRequest,
    mParticleUserCart: mParticleUserCart
};
