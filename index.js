var request = require("request");
var dgram = require('dgram');
var crypto = require('crypto');
var https = require('https');

// require('request-debug')(request);

var Accessory, Service, Characteristic, UUIDGen;

function diff(a, b) {
    return a.filter(function(i) {return b.indexOf(i) < 0;});
};

module.exports = function(homebridge) {
    Accessory = homebridge.platformAccessory;
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    UUIDGen = homebridge.hap.uuid;

    homebridge.registerPlatform("homebridge-plum", "Plum", PlumPlatform);
}

function PlumPlatform(log, config, api) {
    var self = this;
    self.log = log;
    self.config = config;
    self.api = api;
    self.socket = dgram.createSocket('udp4');

    self.accessories = {}; // lpid -> accessory.context -> {room, house, load}
    self.lightpadAddresses = {}; // lpid -> {address, commandPort, streamPort}

    self.socket.on('message', (msg, rinfo) => {
        var response = String(msg).match(/PLUM\ (\d+)\ ([a-f0-9\-]+)\ (\d+)/);
        self.lightpadAddresses[response[2]] = {
            address: rinfo.address, 
            commandPort: parseInt(response[3]),
            streamPort: 2708
        };

        var accessory = self.accessories[response[2]];
        if (accessory) {
            accessory.updateReachability(true);
        }
    });

    self.api.on('didFinishLaunching', function() {
        self.socket.bind(function() {
            self.socket.setBroadcast(true);
            self.socket.send('PLUM', 0, 4, 43770, "255.255.255.255");
        });
        self.login(function() {
            self.log("SUCCESS loading lightpads");
        }, function() {
            self.log("FAILED to get lightpads from cloud!");
        })
    });
}

PlumPlatform.prototype.login = function(onSuccess, onFail) {
    var self = this;
    var plumAPI = request.defaults({
        headers: {
            'User-Agent': 'Plum/2.3.0 (iPhone; iOS 9.2.1; Scale/2.00)'
        },
        auth: {
            user: self.config.username,
            pass: self.config.password
        },
        json: true
    });

    var outstandingRequests = 1;
    var hadError = false;
    var allLpids = Object.keys(self.accessories);
    var foundLpids = [];
    self.log.debug("Getting houses...");
    plumAPI.get('https://production.plum.technology/v2/getHouses', function(error, response, houses) {
        outstandingRequests--;
        self.log.debug(`Found: ${houses}`);
        houses.forEach(function(hid) {
            outstandingRequests++;
            self.log.debug(`Getting house ${hid}...`);
            plumAPI.post({
                url: 'https://production.plum.technology/v2/getHouse',
                json: { "hid": hid }
            }, function(error, response, house) {
                outstandingRequests--;
                self.log.debug(`Found: ${JSON.stringify(house, null, 4)}`);

                house.rids.forEach(function(rid) {
                    outstandingRequests++;
                    self.log.debug(`Getting room ${rid}...`);
                    plumAPI.post({
                        url: 'https://production.plum.technology/v2/getRoom',
                        json: { "rid": rid }
                    }, function(error, response, room) {
                        outstandingRequests--;
                        self.log.debug(`Found: ${JSON.stringify(room, null, 4)}`);

                        room.llids.forEach(function(llid) {
                            outstandingRequests++;
                            self.log.debug(`Getting logical load ${llid}...`);
                            plumAPI.post({
                                url: 'https://production.plum.technology/v2/getLogicalLoad',
                                json: { "llid": llid }
                            }, function(error, response, load) {
                                outstandingRequests--;
                                self.log.debug(`Found: ${JSON.stringify(load, null, 4)}`);

                                load.lpids.forEach(function(lpid) {
                                    foundLpids.push(lpid);
                                    var device = {
                                        room: room,
                                        house: house,
                                        load: load
                                    };
                                    var accessory = self.accessories[lpid];
                                    if (accessory) {
                                        accessory.context.device = device;
                                    } else {
                                        self.addAccessory(`${room["room_name"]} ${load["logical_load_name"]}`, lpid, device);
                                    }
                                });
                                
                                if (outstandingRequests == 0) {
                                    var missingLpids = diff(allLpids, foundLpids);
                                    missingLpids.forEach(function(lpid) {
                                        self.removeAccessory(lpid);
                                    });

                                    onSuccess();
                                }
                            });
                        }); 
                    });
                });
            });
        });
    });
}

PlumPlatform.prototype.configureAccessory = function(accessory) {
    var self = this;
    var lpid = accessory.context.lpid;
    self.log.debug(`Configuring accessory ${accessory.displayName} ${lpid}...`);
    if (!lpid) { return; }

    var service = accessory.getService(Service.Lightbulb);
    if (!service) {
        service = accessory.addService(Service.Lightbulb, accessory.displayName);
    }

    service.getCharacteristic(Characteristic.On)
        .on('set', function(value, callback) {
            var brightness = service.getCharacteristic(Characteristic.Brightness).value;
            if (value && brightness == 0) {
                self.setLevel(accessory, 255, callback);
            } else if (!value && brightness > 0) {
                self.setLevel(accessory, 0, callback);
            } else {
                callback();
            }
            self.log(accessory.displayName, "Light -> " + value);
        })
        .on('get', function(callback) {
            self.getLevel(accessory, function(e, value) {
                callback(null, value > 0);
            });
        });

    service.getCharacteristic(Characteristic.Brightness)
        .on('set', function(value, callback) {
            self.setLevel(accessory, value, callback);
            self.log(accessory.displayName, "Light -> " + value);
        })
        .on('get', function(callback) {
            self.getLevel(accessory, callback);
        });

    accessory.reachable = !!(self.lightpadAddresses[lpid])
    self.accessories[lpid] = accessory;
}

PlumPlatform.prototype.addAccessory = function(accessoryName, lpid, device) {
  var self = this;

  self.log.debug(`Adding accessory ${accessoryName} ${lpid}...`);

  var newAccessory = new Accessory(accessoryName, UUIDGen.generate(accessoryName + lpid));
  newAccessory.context.lpid = lpid;
  newAccessory.context.device = device;
  self.configureAccessory(newAccessory);
  self.api.registerPlatformAccessories("homebridge-plum", "Plum", [newAccessory]);
}

PlumPlatform.prototype.removeAccessory = function(lpid) {
    var self = this;
    var accessory = self.accessories[lpid];
    if (!accessory) { return; }

    self.log.debug(`Removing accessory ${accessory.displayName} ${lpid}...`);

    self.api.unregisterPlatformAccessories("homebridge-plum", "Plum", [accessory]);
    delete self.accessories[lpid];
}

PlumPlatform.prototype.setLevel = function(accessory, level, callback) {
    var self = this;

    self.postLightpad(accessory, '/v2/setLogicalLoadLevel', {
        'level': Math.round((level / 100.0) * 255.0),
        'llid': accessory.context.device.load.llid
    }, function(error, response) {
        self.updateService(accessory, level);
        self.log.debug(`${response.statusCode} from setLevel(${accessory.displayName}, ${level}, ...)`);
        if (callback) { callback(); }
    });
}

PlumPlatform.prototype.getLevel = function(accessory, callback) {
    var self = this;

    self.postLightpad(accessory, '/v2/getLogicalLoadMetrics', {
        'llid': accessory.context.device.load.llid
    }, function(error, response) {
        var level;

        if (!error) {
            var result = JSON.parse(response.body);
            level = Math.round((result.level / 255.0) * 100);
            self.updateService(accessory, level);
        }
        
        self.log.debug(`${response.statusCode} : level=${level} from getLevel(${accessory.displayName}, ...)`);
        if (callback) { callback(null, level); }
    });
}

PlumPlatform.prototype.postLightpad = function(accessory, path, body, callback) {
    var self = this;

    var address = self.lightpadAddresses[accessory.context.lpid];
    
    if (!address) {
        callback();
        return;
    }

    var token = crypto.createHash('sha256')
                    .update(accessory.context.device.house['house_access_token'])
                    .digest('hex');

    var blubAPI = request.defaults({
        headers: {
            'User-Agent': 'Plum/2.3.0 (iPhone; iOS 9.2.1; Scale/2.00)',
            'X-Plum-House-Access-Token': token,
            'Content-Type': 'application/json'
        },
        agent: new https.Agent({
            host: address.address, 
            port: address.commandPort, 
            path: path, 
            rejectUnauthorized: false
        })
    });

    blubAPI.post({ 
        url: `https://${address.address}:${address.commandPort}${path}`, 
        body: JSON.stringify(body)
    }, callback);
}

PlumPlatform.prototype.updateService = function(accessory, level) {
    var service = accessory.getService(Service.Lightbulb);
    service.getCharacteristic(Characteristic.On).updateValue(level > 0);
    service.getCharacteristic(Characteristic.Brightness).updateValue(level);
}
