const axios = require('axios');
const Apify = require('apify');
const cheerio = require('cheerio');
const moment = require('moment');
const check = require('check-types');

const {
    callForReview,
    buildHotelUrl,
    buildRestaurantUrl,
    buildAttractionsUrl,
    getAgentOptions,
    getReviewTagsForLocation,
} = require('./api');
const { getConfig } = require('./data-limits');

const { utils: { log } } = Apify;

function randomDelay(minimum = 200, maximum = 600) {
    const min = Math.ceil(minimum);
    const max = Math.floor(maximum);
    return Apify.utils.sleep(Math.floor(Math.random() * (max - min + 1)) + min);
}

function getSecurityToken($) {
    let securityToken = null;
    $('head script').each((index, element) => {

        if ($(element).get()[0].children[0] && $(element).get()[0].children[0].data.includes("define('page-model', [], function() { return ")) {
            let scriptText = $(element).get()[0].children[0].data;
            scriptText = scriptText.replace("define('page-model', [], function() { return ", '');
            scriptText = scriptText.replace('; });', '');
            const scriptObject = JSON.parse(scriptText);
            securityToken = scriptObject.JS_SECURITY_TOKEN;
        }
    });
    return securityToken;
}

function getCookies(response) {
    let sessionCookie = null;
    let taudCookie = null;
    response.headers['set-cookie'].forEach((d) => {
        if (d.includes('TASession')) {
            [sessionCookie] = d.split(';');
        }
        if (d.includes('TAUD')) {
            [taudCookie] = d.split(';');
        }
    });
    return `${sessionCookie};${taudCookie}`;
}

async function resolveInBatches(promiseArray, batchLength = 10) {
    const promises = [];
    for (const promise of promiseArray) {
        if (typeof promise === 'function') {
            promises.push(promise());
        } else {
            promises.push(promise);
        }
        if (promises.length % batchLength === 0) await Promise.all(promises);
    }
    return Promise.all(promises);
}

const processReview = (review, remoteId) => {
    const { text, title, rating, tripInfo, publishedDate, userProfile } = review;
    const stayDate = tripInfo ? tripInfo.stayDate : null;
    let userLocation = null;
    let userContributions = null;

    log.debug(`Processing review: ${title}`);
    if (userProfile) {
        const { hometown, contributionCounts = {} } = userProfile;
        const { sumReview } = contributionCounts;
        userContributions = sumReview;
        userLocation = hometown.fallbackString;

        if (hometown.location) {
            userLocation = hometown.location.additionalNames.long;
        }
    }

    return {
        text,
        title,
        rating,
        stayDate,
        publishedDate,
        userLocation,
        userContributions,
        remoteId,
    };
};

function findLastReviewIndexByDate(reviews, dateKey) {
    return reviews.findIndex((r) => {
        let rDate;
        if (dateKey) {
            rDate = moment(r[dateKey]);
        } else {
            rDate = moment(r.publishedDate);
        }
        const userMaxDate = moment(global.LAST_REVIEW_DATE);
        return rDate.isBefore(userMaxDate);
    });
}

async function getReviews(id, client) {
    const result = [];
    let offset = 0;
    const limit = 20;
    let totalReviews = 0;
    let numberOfFetches = 0;
    const { maxReviews } = getConfig();

    try {
        const resp = await callForReview(id, client, offset, limit);
        const { errors } = resp.data[0];

        if (errors) {
            log.error('Graphql error', errors);
        }

        const reviewData = resp.data[0].data.locations[0].reviewList || {};
        const { totalCount } = reviewData;
        total = totalCount;
        let { reviews = [] } = reviewData;
        const lastIndexByDate = findLastReviewIndexByDate(reviews);
        const shouldSlice = lastIndexByDate >= 0;
        if (shouldSlice) {
            reviews = reviews.slice(0, lastIndexByDate);
        }
       
        const lastIndexByReviewsLimit = maxReviews > 0 ? maxReviews : -1;
        const smallestIndex =  getSmallestIndexGreaterThanEqualZero(lastIndexByDate, lastIndexByReviewsLimit);
        const numberOfReviews = (smallestIndex === -1 || totalCount < smallestIndex) ? totalCount : smallestIndex;

        log.info(`Going to process ${numberOfReviews} reviews`);
        
        numberOfFetches = Math.ceil(numberOfReviews / limit);
        
        if (reviews.length >= 1) {
            reviews.forEach(review => result.push(processReview(review)));
        }
        
        if (shouldSlice) return result;
    } catch (e) {
        log.error(e, 'Could not make initial request');
    }
    let response;
    
    try {
        for (let i = 1; i < numberOfFetches; i++) {
            offset += limit;
            response = await callForReview(id, client, offset, limit);
            const reviewData = response.data[0].data.locations[0].reviewList;
            let { reviews } = reviewData;
            const lastIndexByDate = findLastReviewIndexByDate(reviews);
            const lastIndexByReviewsLimit = maxReviews > 0 ? maxReviews - offset : -1;
            const smallestIndex =  getSmallestIndexGreaterThanEqualZero(lastIndexByDate, lastIndexByReviewsLimit);
            const shouldSlice = smallestIndex >= 0;
            if (shouldSlice) {
                reviews = reviews.slice(0, smallestIndex);
            }
            reviews.forEach(review => result.push(processReview(review)));
            if (shouldSlice) break;
            await Apify.utils.sleep(300);
        }
    } catch (e) {
        log.error(e, 'Could not make additional requests');
    }
    return result;
    }

function getSmallestIndexGreaterThanEqualZero(indexA, indexB){
    if (indexA >= 0 && indexB < 0){
        return indexA;
    }
    if (indexB >= 0 && indexA < 0){
        return indexB;
    } 
    if (indexA >= 0 && indexB >= 0){
        return indexB > indexA ? indexB : indexA;
    } 
    return -1;
}

function getRequestListSources(locationId, includeHotels, includeRestaurants, includeAttractions) {
    const sources = [];
    if (includeHotels) {
        sources.push({
            url: buildHotelUrl(locationId),
            userData: { initialHotel: true },
        });
    }
    if (includeRestaurants) {
        sources.push({
            url: buildRestaurantUrl(locationId),
            userData: { initialRestaurant: true },
        });
    }
    if (includeAttractions) {
        sources.push({
            url: buildAttractionsUrl(locationId),
            userData: {
                initialAttraction: true,
            },
        });
    }
    console.log(sources)
    return sources;
}

async function getClient(session) {
    const response = await axios.get('https://www.tripadvisor.com/Hotels-g28953-New_York-Hotels.html', getAgentOptions(session));
    const $ = cheerio.load(response.data);
    return axios.create({
        baseURL: 'https://www.tripadvisor.co.uk/data/graphql',
        headers: {
            'x-requested-by': getSecurityToken($),
            Cookie: getCookies(response),
        },
        ...getAgentOptions(session),
    });
}
function validateInput(input) {
    const {
        locationFullName,
        hotelId,
        restaurantId,
        includeRestaurants,
        includeHotels,
        includeReviews,
        lastReviewDate,
        includeAttractions,
        checkInDate,
    } = input;
    const getError = (property, type = 'string') => new Error(`${property} should be a ${type}`);
    const checkStringProperty = (property, propertyName) => {
        if (property && !check.string(property)) {
            throw getError(propertyName);
        }
    };
    const checkBooleanProperty = (property, propertyName) => {
        if (property && !check.boolean(property)) {
            throw getError(propertyName, 'boolean');
        }
    };

    const checkDateFormat = (date, format = 'YYYY-MM-DD') => {
        if (moment(date, format).format(format) !== date) {
            throw new Error(`Date: ${date} should be in format ${format}`);
        }
    };

    // Check types
    // strings
    checkStringProperty(locationFullName, 'locationFullName');
    checkStringProperty(hotelId, 'hotelId');
    checkStringProperty(restaurantId, 'restaurantId');
    checkStringProperty(lastReviewDate, 'lasReviewData');

    // boleans
    checkBooleanProperty(includeRestaurants, 'includeRestaurants');
    checkBooleanProperty(includeHotels, 'includeHotels');
    checkBooleanProperty(includeReviews, 'includeReviews');
    checkBooleanProperty(includeAttractions, 'includeAttractions');

    // dates
    if (lastReviewDate) {
        checkDateFormat(lastReviewDate);
    }
    if (checkInDate) {
        checkDateFormat(checkInDate);
    }

    // Should have all required fields
    if (!locationFullName && !hotelId && !restaurantId) {
        throw new Error('At least one of properties: locationFullName, hotelId, restaurantId should be set');
    }
    if (!includeHotels && !includeRestaurants && !includeAttractions) {
        throw new Error('At least one of properties: includeHotels or includeRestaurants should be true');
    }
    log.info('Input validation OK');
}

async function getReviewTags(locationId) {
    let tags = [];
    let offset = 0;
    const limit = 20;
    const data = await getReviewTagsForLocation(locationId, limit);
    tags = tags.concat(data.data);
    if (data.paging && data.paging.next) {
        const totalResults = data.paging.total_results;
        const numberOfRuns = Math.ceil(totalResults / limit);
        log.info(`Going to process ${numberOfRuns} pages of ReviewTags, ${data.paging}`);
        for (let i = 0; i <= numberOfRuns; i++) {
            offset += limit;
            const data2 = await getReviewTagsForLocation(locationId, limit, offset);
            tags = tags.concat(data2.data);
        }
    }
    return tags;
}

module.exports = {
    resolveInBatches,
    getRequestListSources,
    getClient,
    randomDelay,
    validateInput,
    getReviewTags,
    getReviews,
    findLastReviewIndex: findLastReviewIndexByDate,
};
