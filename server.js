const fs = require('fs');
const mbgl = require('@maplibre/maplibre-gl-native');
const mercator = new (require('@mapbox/sphericalmercator'))();
const betterSqlite = require('better-sqlite3');
const path = require('path');
const render = require('./serve_render');
const config = require('/data/change_color_and_format_config.json');
const logPath = '/data/log.txt';

const limit = 1000;
const tileSize = config['tileSize'] || 512,
    scale = config['scale'] || 1;
let topRightCorner = [-90.0, -180.0];
let sourceZoom = 2;
let targetZoom = 10;  // E.g. Here cut level 10 tiles by level 2 grid
let bount = undefined;

mbgl.on('message', function (err) {
    if (err.severity === 'WARNING' || err.severity === 'ERROR') {
        console.log('mbgl:', err);
    }
});

let connectDb = function (dbPath, attachPath) {
    if (dbPath && attachPath && attachPath !== dbPath) {
        const db = betterSqlite(dbPath, /*{ verbose: console.log }*/);
        db.prepare('ATTACH DATABASE ? AS raster').run(attachPath);
        return db;
    }
    return betterSqlite(dbPath || attachPath, /*{ verbose: console.log }*/);
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
// proj: 4326
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
// proj: 3857
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
    let sqliteQueue = [], isDir = true;
    const loopThroughtDir = (inputPath) => {
        const filelist = fs.readdirSync(inputPath);
        for (let file of filelist) {
            if (fs.lstatSync(path.resolve(inputPath, file)).isDirectory()) {
                loopThroughtDir(path.resolve(inputPath, file));
            } else {
                if (file.endsWith('.sqlite') || file.endsWith('.mbtiles')) {
                    sqliteQueue.push(path.resolve(inputPath, file));
                }
            }
        }
    };
    if (inputPath.endsWith('sqlite') || inputPath.endsWith('mbtiles')) {
        sqliteQueue = [`${inputPath}`]
        isDir = false;
    } else {
        loopThroughtDir(inputPath);
    }
    return { sqliteQueue, isDir };
}

function getCount(db, attached) {
    if (attached) {
        return db.prepare(`
            SELECT count(1) from (
                select zoom_level, tile_column, tile_row from tiles
                union select zoom_level, tile_column, tile_row from raster.tiles
            );`).pluck().get();
    }
    return db.prepare(`SELECT count(1) from tiles;`).pluck().get();
}

function fetchTile(db, pagination, attached) {
    if (attached) {
        return db.prepare(`
            SELECT zoom_level z, tile_column x, tile_row y FROM ( 
                SELECT a.zoom_level zoom_level, a.tile_column tile_column, a.tile_row tile_row FROM tiles a
                    LEFT JOIN raster.tiles b ON 
                    b.zoom_level = a.zoom_level and b.tile_column = a.tile_column and b.tile_row = a.tile_row
                UNION
                SELECT a.zoom_level zoom_level, a.tile_column tile_column, a.tile_row tile_row FROM raster.tiles a
                    LEFT JOIN tiles b ON 
                    b.zoom_level = a.zoom_level and b.tile_column = a.tile_column and b.tile_row = a.tile_row
            ) ORDER BY zoom_level, tile_column, tile_row  LIMIT ${pagination['limit']} OFFSET ${pagination['offset']};`).all();
    }
    return db.prepare(`SELECT zoom_level as z, tile_column as x, tile_row as y from tiles limit ${pagination['limit']} offset ${pagination['offset']};`).all();

}

function fetchTileByZXY(db, z, x, y) {
    return db.prepare(`
        SELECT zoom_level z, tile_column x, tile_row y FROM ( 
            SELECT a.zoom_level zoom_level, a.tile_column tile_column, a.tile_row tile_row FROM tiles a
                LEFT JOIN raster.tiles b ON 
                b.zoom_level = a.zoom_level and b.tile_column = a.tile_column and b.tile_row = a.tile_row WHERE a.zoom_level = ${z} AND a.tile_column = ${x} AND a.tile_row = ${y}
            UNION
            SELECT a.zoom_level zoom_level, a.tile_column tile_column, a.tile_row tile_row FROM raster.tiles a
                LEFT JOIN tiles b ON 
                b.zoom_level = a.zoom_level and b.tile_column = a.tile_column and b.tile_row = a.tile_row WHERE a.zoom_level = ${z} AND a.tile_column = ${x} AND a.tile_row = ${y}
        ) ORDER BY zoom_level, tile_column, tile_row  LIMIT 1 OFFSET 0;`).all();
}

function formatPath(vectorPath, rasterQueue, format, proj, isDir) {
    const extname = path.extname(vectorPath);
    let rasterPath = rasterQueue && (rasterQueue?.find(p => p.endsWith(path.basename(vectorPath))) || !isDir && rasterQueue[0]) || undefined;
    // // 判断是否是raster的路径，
    // // 如果是，那说明没有跟他对应的vector，是被getQueue()方法merge的
    // // 此时应将vectorPath置为undefined
    if (rasterPath === vectorPath) {
        vectorPath = undefined
    }
    console.log('vectorPath:', vectorPath, 'rasterPath:', rasterPath);
    const vectorMbTilePath = vectorPath ? `mbtiles://${vectorPath}` : undefined
    const rasterMbTilePath = rasterPath ? `mbtiles://${rasterPath}` : undefined
    let outputPath = ''
    if (vectorPath) {
        outputPath += path.basename(vectorPath, extname) + '_'
    }
    if (rasterPath) {
        outputPath += path.basename(rasterPath, extname) + '_'
    }


    outputPath = `${outputPath}${format}_${proj}` + extname;
    outputPath = args.options.paths['output'] ?
        path.resolve(args.options.paths['output'], outputPath) : path.resolve(args.options.paths.mbtiles, outputPath);
    return { vectorMbTilePath, rasterMbTilePath, outputPath, rasterPath };
}

function isArrayEqual(arr1, arr2) {
    if (arr1.length !== arr2.length) {
        return false; // 数组长度不同，元素肯定不一致
    }

    const sortedArr1 = arr1.slice().sort();
    const sortedArr2 = arr2.slice().sort();

    for (let i = 0; i < sortedArr1.length; i++) {
        if (sortedArr1[i] !== sortedArr2[i]) {
            return false; // 发现有不相同的元素，返回 false
        }
    }

    return true; // 所有元素都相同，返回 true
}

function getQueue(id) {
    let vectorQueue = [], rasterQueue = [], isVectorDir = true, isRasterDir = true;
    const styleJSONPath = path.resolve(args.options.paths.styles, args.styles[id].style)
    let styleJSON = JSON.parse(fs.readFileSync(styleJSONPath))
    for (const i of Object.keys(args.data)) {
        if (styleJSON.sources[i].type === 'vector') {
            const vectorDir = path.resolve(args.options.paths.mbtiles, args.data[i].mbtiles);
            console.log(`vectorDir: ${vectorDir}`)
            const fileObj = getFilelist(vectorDir);
            vectorQueue = [...vectorQueue, ...fileObj.sqliteQueue]
            isVectorDir = fileObj.isDir
            continue;
        }
        if (styleJSON.sources[i].type === 'raster') {
            const rasterDir = path.resolve(args.options.paths.mbtiles, args.data[i].mbtiles);
            console.log(`rasterDir: ${rasterDir}`)
            const fileObj = getFilelist(rasterDir);
            rasterQueue = [...rasterQueue, ...fileObj.sqliteQueue]
            isRasterDir = fileObj.isDir
            continue;
        }
    }
    const vectorFilelist = vectorQueue?.map(p => path.basename(p)) || [];
    const rasterFilelist = rasterQueue?.map(p => path.basename(p)) || [];
    const isEqual = isArrayEqual(vectorFilelist, rasterFilelist);
    let mergedQueue = [...vectorQueue];
    // 矢量栅格以网格号为名的数据融合。
    // 如两个文件列表不同，且都是目录，则将rasterFilelist中有，vectorFilelist中没有的文件合并到mergeQueue中
    if (!isEqual && isVectorDir && isRasterDir) {
        rasterFilelist.map(p => {
            if (!vectorFilelist.includes(p)) {
                const rasterMbtile = rasterQueue.find(q => q.endsWith(p))
                if (rasterMbtile) {
                    mergedQueue.push(rasterMbtile)
                }
            }
        });
    } else {
        // 路径不是目录，且是两个栅格数据融合
        if (rasterQueue.length === 2) {
            mergedQueue = [rasterQueue[0]]
            rasterQueue = [rasterQueue[1]]
        }
    }
    return { vectorQueue, rasterQueue, mergedQueue, isDir: isVectorDir && isRasterDir };
}

const args = config;
let readMbtiles = async function () {
    console.log('args:', args);
    const metadata = args.options.paths['metadata'];
    const proj = args.options['proj'] || 4326;
    const format = args.options['format'] || 'webp';
    const id = 'vector';
    let { vectorQueue, rasterQueue, mergedQueue, isDir } = getQueue(id);

    console.log('vectorQueue:', vectorQueue, 'rasterQueue', rasterQueue, 'mergedQueue', mergedQueue, 'isDir', isDir);
    for (let vectorPath of mergedQueue) {
        const { vectorMbTilePath, rasterMbTilePath, outputPath, rasterPath } = formatPath(vectorPath, rasterQueue, format, proj, isDir);
        // 启动渲染pool
        await render.serve_render_add(vectorMbTilePath, rasterMbTilePath, isDir);
        console.log('No.', vectorQueue.indexOf(vectorPath) + 1, 'outputDbPath:', outputPath);
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }
        const inputDb = connectDb(vectorPath);
        let metadataPath
        if (metadata) {
            metadataPath = path.resolve(metadata);
            if (!fs.existsSync(metadataPath)) {
                console.error(`path ${metadataPath} not existed!`, metadataPath);
            }
        }
        console.log('prepare outputDb ...');
        const outputDb = await createDb(metadataPath, inputDb, outputPath);
        console.log('calculate pagination ...');
        const startTime = Date.now();
        // 判断rasterPath是否为空，更新查询语句
        const attached =  vectorPath && rasterPath && rasterPath !== vectorPath
        const attachedDB = connectDb(vectorPath, rasterPath);
        const count = getCount(attachedDB, attached);
        const pageCount = Math.ceil(count / limit);
        // const pageCount = 1;
        console.log('Total count', count, ', page count', pageCount, ', page limit', limit);
        let currCount = 0;
        let overBoundCount = 0;
        for (let i = 0; i < pageCount; i++) {
            const offset = i * limit;
            const data = fetchTile(attachedDB, { offset, limit }, attached);
            // const data = [{ z: 4, x: 11, y: 6 }];
            console.log('progress: ', offset, '-', offset + data.length);
            let res = [];
            for (let item of data) {
                let { z, x, y } = item;
                // 3857的需要对y做翻转
                if (proj === 3857) {
                    y = 2 ** z - 1 - y;
                } else if (isOverBound(vectorPath, z, x, y)) {
                    // 3857的按全球的处理，不用计算是否超边界
                    overBoundCount++;
                    continue;
                }
                const tileCenter = proj === 3857 ? mercatorCenter(z, x, y) : calCenter(z, x, y);
                // console.log('z', z, 'x', x, 'y', y, 'tileCenter', tileCenter[0].toFixed(20), tileCenter[1].toFixed(20));
                tileCenter[0] = parseFloat(tileCenter[0].toFixed(20));
                tileCenter[1] = parseFloat(tileCenter[1].toFixed(20));
                item = await render.renderImage(z, x, y, tileCenter, format, tileSize, scale);
                // console.log(item, 'item_________________')
                // fs.writeFileSync(`/data/${z}_${x}_${y}-out2.webp`, item.tile_data)
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
        console.log('Total count', count, ', insert count:', currCount, ', overBoundCount:', overBoundCount, ', insert count + overBoundCount: ', currCount + overBoundCount);
        console.log('Create index ...');
        createIndex(outputPath);
        console.log('Create index finished!');
        console.log('Finshed! Total time cost:', (Date.now() - startTime) / 1000 / 60);
        fs.appendFileSync(logPath, 'No. ' + (vectorQueue.indexOf(vectorPath) + 1) + ' ' + new Date().toLocaleString() + ' ' + outputPath + '\n');
    }
    console.log('All are finished successfully!');
    render.serve_render_remove(render.repo, id);
}

readMbtiles()

// run script local, recommand use docker envrionment
// sudo apt-get update && sudo apt-get install xvfb && npm install
// EGL_LOG_LEVEL=debug
// output: /input/db/path_png.mbtiles located at the same path
// e.g.: xvfb-run -a -s '-screen 0 1024x768x24' node server.js
