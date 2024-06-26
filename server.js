const fs = require('fs');
const mbgl = require('@maplibre/maplibre-gl-native');
const mercator = new (require('@mapbox/sphericalmercator'))();
const sharp = require('sharp');
const betterSqlite = require('better-sqlite3');
const zlib = require('node:zlib');
const path = require('path');
const render = require('./serve_render');
const config = require('/data/change_color_and_format_config.json');
const logPath = '/data/log.txt';

const limit = 1000;
const tileSize = 256,
    scale = 1,
    bearing = 0,
    pitch = 0,
    ratio = 1;
let topRightCorner = [-90.0, -180.0];
let sourceZoom = 2;
let targetZoom = 10;  // E.g. Here cut level 10 tiles by level 2 grid
let bount = undefined;

mbgl.on('message', function (err) {
    if (err.severity === 'WARNING' || err.severity === 'ERROR') {
        console.log('mbgl:', err);
    }
});

let connectDb = function (dbPath) {
    return betterSqlite(dbPath, /*{ verbose: console.log }*/);
}

let parseMetadata = function (metadataPath) {
    const fileBuff = fs.readFileSync(metadataPath);
    let metadata = JSON.parse(fileBuff);
    metadata.json = JSON.stringify(JSON.parse(metadata.json));
    return Object.keys(metadata).map(key => {
        return { 'name': key, 'value': metadata[key] }
    });
}

let createDb = async function (metadataPath, inputDb, outputPath) {
    const outputDb = connectDb(outputPath);
    outputDb.prepare('CREATE TABLE IF NOT EXISTS metadata (name text, value text)').run();
    let meta;
    if (metadataPath) {
        meta = parseMetadata(metadataPath, inputDb);
    } else {
        meta = inputDb.prepare(`SELECT * from metadata;`).all();
    }
    let insert = outputDb.prepare(`INSERT INTO metadata (name, value) VALUES (@name, @value);`);
    const insertMany = outputDb.transaction(async (mdata) => {
        for (let item of mdata) {
            insert.run(item);
        }
    });
    await insertMany(meta);
    outputDb.prepare('CREATE TABLE IF NOT EXISTS tiles (zoom_level integer NOT NULL, tile_column integer NOT NULL, tile_row integer NOT NULL, tile_data blob)').run();
    return outputDb;
}
let createIndex = function (outputPath) {
    const outputDb = connectDb(outputPath);
    outputDb.prepare('CREATE UNIQUE INDEX IF NOT EXISTS tile_index ON tiles ( "zoom_level" ASC,"tile_column" ASC, "tile_row" ASC);').run();
}

const scaleDenominator_dic = {
    '0': 279541132.014358,
    '1': 139770566.007179,
    '2': 69885283.0035897,
    '3': 34942641.5017948,
    '4': 17471320.7508974,
    '5': 8735660.37544871,
    '6': 4367830.18772435,
    '7': 2183915.09386217,
    '8': 1091957.54693108,
    '9': 545978.773465544,
    '10': 272989.386732772,
    '11': 136494.693366386,
    '12': 68247.346683193,
    '13': 34123.6733415964,
    '14': 17061.8366707982,
    '15': 8530.91833539913,
    '16': 4265.45916769956,
    '17': 2132.72958384978
};


let truncate_lnglat = function (lng, lat) {
    if (lng > 180.0) {
        lng = 180.0
    }
    else if (lng < -180.0) {
        lng = -180.0
    }
    if (lat > 90.0) {
        lat = 90.0
    }
    else if (lat < -90.0) {
        lat = -90.0
    }
    return [lng, lat];
}

let ul = function (z, x, y, curCorner) {
    let scaleDenominator = scaleDenominator_dic[(z).toString()];
    let res = scaleDenominator * 0.00028 / (2 * Math.PI * 6378137 / 360.0);
    let origin_x = curCorner ? curCorner[1] : topRightCorner[1];
    let origin_y = curCorner ? curCorner[0] : topRightCorner[0];
    let lon = origin_x + x * res * tileSize;
    let lat = origin_y - y * res * tileSize;
    return [lon, lat];
}

let calCenter = function (z, x, y) {
    let lt = ul(z, x, y);
    let left = lt[0], top = lt[1];
    let rb = ul(z, x + 1, y + 1);
    let right = rb[0], bottom = rb[1];
    let curCorner = [parseFloat(top.toFixed(20)), parseFloat((-right).toFixed(20))];
    // console.log('curCorner', curCorner);
    let center = ul(z, x, y, curCorner);
    return truncate_lnglat.apply(null, center);
}

const mercatorCenter = function (z, x, y) {
    return mercator.ll([
        ((x + 0.5) / (1 << z)) * (256 << z),
        ((y + 0.5) / (1 << z)) * (256 << z)
    ], z);
}

let getBound = function (x, y, targetZoom, sourceZoom, args) {
    // console.log(x, y);
    targetZoom = Number.parseInt(targetZoom);
    sourceZoom = Number.parseInt(sourceZoom);
    const minX = x * Math.pow(2, targetZoom - sourceZoom);
    const maxX = minX + Math.pow(2, targetZoom - sourceZoom) - 1;
    const minY = y * Math.pow(2, targetZoom - sourceZoom);
    const maxY = minY + Math.pow(2, targetZoom - sourceZoom) - 1;
    return { minX, maxX, minY, maxY };
}

function isOverBound(inputPath, z, x, y, args) {
    const [boundX, boundY, targetZoom] = path.basename(inputPath, '.sqlite').split(/[\-\_]/).map(p => Number.parseInt(p)).filter(p => !Number.isNaN(p));
    // console.log('z', z, 'x', x, 'y', y , 'boundX', boundX, 'boundY', boundY, 'targetZoom, targetZoom);
    bound = bount ? bount : getBound(boundX, boundY, targetZoom, sourceZoom, args);
    const inBound = z == targetZoom && x >= bound.minX && x <= bound.maxX && y <= bound.maxY && y >= bound.minY;
    const isOverBound = z !== targetZoom || x < bound.minX || x > bound.maxX || y > bound.maxY || y < bound.minY;
    // console.log('z', z, 'x', x, 'y', y, 'isOverBound', isOverBound);
    if (!inBound !== isOverBound)
        console.log('isOverBound _ || not equal to inBound, isOverBound', isOverBound, 'inBound', inBound);
    return isOverBound
}

function getFilelist(inputPath) {
    let sqliteQueue = [];
    const loopThroughtDir = (inputPath) => {
        const filelist = fs.readdirSync(inputPath);
        for (let file of filelist) {
            if (fs.lstatSync(path.resolve(inputPath, file)).isDirectory()) {
                loopThroughtDir(path.resolve(inputPath, file));
            } else {
                if (file.endsWith('.sqlite')) {
                    sqliteQueue.push(path.resolve(inputPath, file));
                }
            }
        }
    };
    if (inputPath.endsWith('sqlite') || inputPath.endsWith('mbtiles')) {
        sqliteQueue = [`${inputPath}`]
    } else {
        loopThroughtDir(inputPath);
    }
    return sqliteQueue;
}

function getCount(vectorPath, rasterPath) {
    return connectDb(vectorPath).exec(`attch ${rasterPath} as raster`).prepare(`
        SELECT count(1) from (
            select zoom_level, tile_column, tile_row from tiles
            union select zoom_level, tile_column, tile_row from raster.tiles
        );`).pluck().get();
}

function fetchTile(vectorPath, rasterPath) {
    const db = connectDb(vectorPath);
    db.exec(`attch ${rasterPath} as raster`);
    return db.prepare(`
        SELECT zoom_level, tile_column, tile_row, src_tile_data, tar_tile_data FROM ( 
            SELECT a.zoom_level zoom_level, a.tile_column tile_column, a.tile_row tile_row, a.tile_data src_tile_data, b.tile_data tar_tile_data FROM tiles a
                LEFT JOIN tar_mb.tiles b ON 
                b.zoom_level = a.zoom_level and b.tile_column = a.tile_column and b.tile_row = a.tile_row WHERE a.zoom_level= ? 
            UNION
            SELECT a.zoom_level zoom_level, a.tile_column tile_column, a.tile_row tile_row, b.tile_data src_tile_data, a.tile_data tar_tile_data FROM tar_mb.tiles a
                LEFT JOIN tiles b ON 
                b.zoom_level = a.zoom_level and b.tile_column = a.tile_column and b.tile_row = a.tile_row WHERE a.zoom_level= ?
        ) ORDER BY zoom_level, tile_column, tile_row, src_tile_data, tar_tile_data LIMIT ? OFFSET ?;`).all();
}

const args = config;
const renderConfig = require('/data/config.json');
let readMbtiles = async function () {
    console.log('args:', args);
    const inputDirPath = args['inputDirPath'];
    const metadataDirPath = args['metadataDirPath'];
    const proj = args['proj'];
    const format = args['format'];
    const id = 'vector';
    const repo = render.repo;
    await render.serve_render_add();
    const sqliteQueue = [path.resolve(renderConfig.options.paths.mbtiles, renderConfig.data[id].mbtiles)];
    // const sqliteQueue = ['/data/0-8.mbtiles'];
    console.log('sqliteQueue:', sqliteQueue);
    for (let inputPath of sqliteQueue) {
        let outputPath = (inputPath.endsWith('sqlite') ? path.basename(inputPath, '.sqlite') : path.basename(inputPath, '.mbtiles')) + '_webp' + '.mbtiles';
        outputPath = args['outputDirPath'] ? path.resolve(args['outputDirPath'], outputPath) : path.resolve(args['inputDirPath'], outputPath);
        console.log('No.', sqliteQueue.indexOf(inputPath) + 1, 'outputDbPath:', outputPath);
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }
        const inputDb = connectDb(inputPath);
        let metadataPath = undefined;
        if (metadataDirPath) {
            metadataPath = path.resolve(metadataDirPath, path.basename(inputPath, '.sqlite').split(/[\_]/).find(p => p.startsWith('sea2')), 'metadata.json');
            if (!fs.existsSync(metadataPath)) {
                console.log(`path ${metadataPath} not existed!`, metadataPath);
            }
        }
        console.log('prepare outputDb ...');
        const outputDb = await createDb(metadataPath, inputDb, outputPath);
        console.log('calculate pagination ...');
        const startTime = Date.now();
        const count = inputDb.prepare(`SELECT count(1) from tiles;`).pluck().get();
        const pageCount = Math.ceil(count / limit);
        console.log('Total count', count, ', page count', pageCount, ', page limit', limit);
        let currCount = 0;
        let overBoundCount = 0;
        for (let i = 0; i < pageCount; i++) {
            const offset = i * limit;
            const data = inputDb.prepare(`SELECT zoom_level as z, tile_column as x, tile_row as y from tiles limit ${limit} offset ${offset};`).all();
            console.log('progress: ', offset, '-', offset + data.length);
            let res = [];
            for (let item of data) {
                let { z, x, y } = item;
                // 3857的需要对y做翻转
                if (proj === 3857) {
                    y = 2 ** z - 1 - y;
                } else if (isOverBound(inputPath, z, x, y)) {
                    // 3857的按全球的处理，不用计算是否超边界
                    overBoundCount++;
                    continue;
                }
                const tileCenter = proj === 3857 ? mercatorCenter(z, x, y) : calCenter(z, x, y);
                console.log('z', z, 'x', x, 'y', y, 'topRightCorner', topRightCorner, 'tileCenter', tileCenter[0].toFixed(20), tileCenter[1].toFixed(20));
                tileCenter[0] = parseFloat(tileCenter[0].toFixed(20));
                tileCenter[1] = parseFloat(tileCenter[1].toFixed(20));
                item = await render.renderImage(z, x, y, tileCenter, format, tileSize, scale);

                res.push(item);
            }
            const insert = outputDb.prepare(`INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (@zoom_level, @tile_column, @tile_row, @tile_data);`);
            const insertMany = outputDb.transaction(async (ndata) => {
                for (let item of ndata) {
                    insert.run(item);
                    currCount++
                }
            });
            const readyData = await Promise.all(res);
            await insertMany(readyData);
            console.log('Insert count:', currCount, ', overBoundCount:', overBoundCount);
        }
        console.log('Total count', count, ', insert count:', currCount, ', overBoundCount:', overBoundCount, 'insert count + overBoundCount: ', currCount + overBoundCount);
        console.log('Create index ...');
        createIndex(outputPath);
        console.log('Create index finished!');
        console.log('Finshed! Total time cost:', (Date.now() - startTime) / 1000 / 60);
        fs.appendFileSync(logPath, 'No. ' + (sqliteQueue.indexOf(inputPath) + 1) + ' ' + new Date().toLocaleString() + ' ' + outputPath + '\n');
    }

    console.log('finished')
    render.serve_render_remove(repo, id);
}

readMbtiles()

// run script local, recommand use docker envrionment
// sudo apt-get update && sudo apt-get install xvfb && npm install
// EGL_LOG_LEVEL=debug
// output: /input/db/path_png.mbtiles located at the same path
// xvfb-run -a -s '-screen 0 1024x768x24' node server.js
// e.g.: xvfb-run -a -s '-screen 0 1024x768x24' node server.js
