"use strict";
// --------------------------------------------------------------------------
// Require statements
// --------------------------------------------------------------------------
var express = require("express");
var bodyParser = require("body-parser");
var request = require("request");
var requestjs = require("request-json");
var crypto = require("crypto");
var _ = require("underscore");
var async = require("async");
var Cloudant = require("cloudant");
var fs = require("fs");

// --------------------------------------------------------------------------
// Setup global variables
// --------------------------------------------------------------------------
var textBreakGQL = "\\r\\n";
var textBreak = "\r\n";

// Workspace API Setup - fixed stuff
const WWS_URL = "https://api.watsonwork.ibm.com";
const AUTHORIZATION_API = "/oauth/token";
const OAUTH_ENDPOINT = "/oauth/authorize";
const WEBHOOK_VERIFICATION_TOKEN_HEADER = "X-OUTBOUND-TOKEN".toLowerCase();

// ICS Log Setup
const LOG_APP = "IWWDemoGenerator";
const LOG_FEATURE = "Demo Generator";
var LOG_DC;
var LOG_AUTHOR;

// These should be entered as additional environment variables when running on
// Bluemix
// The Workspace App IDs
const APP_ID = "<application id>";
const APP_SECRET = "<application secret>";
const APP_WEBHOOK_SECRET = "<Web Hook Secret>";
const APP_URL = "<application url>";
const DEMO_USER_EMAIL = "<Watson Workspace User Email Address>";
const SPACE_ID_WWLABQA = "";

// cloudantNoSQLDB
var CLOUDANT_USER;
var CLOUDANT_PW;

// --------------------------------------------------------------------------
// Read environment variables
// --------------------------------------------------------------------------

// When not present in the system environment variables, dotenv will take them
// from the local file
require('dotenv').config({silent: true, path: 'my.env'});

// See if you can get them from Bluemix bound services (VCAP_SERVICES)
if (process.env.VCAP_SERVICES) {
  var bluemix_env = JSON.parse(process.env.VCAP_SERVICES);
  console.log("Checking VCAP_SERVICES");

  // Check if we have the cloudant api
  if (bluemix_env.cloudantNoSQLDB) {
    CLOUDANT_USER = bluemix_env.cloudantNoSQLDB[0].credentials.username;
    CLOUDANT_PW = bluemix_env.cloudantNoSQLDB[0].credentials.password;
    console.log("Cloudant API keys coming from Bluemix VCAP");
  } else {
    CLOUDANT_USER = process.env.CLOUDANT_USER;
    CLOUDANT_PW = process.env.CLOUDANT_PW;
    console.log("Cloudant API not found in VCAP_SERVICES, keys coming from local");
  }

} else {
  CLOUDANT_USER = process.env.CLOUDANT_USER;
  CLOUDANT_PW = process.env.CLOUDANT_PW;
  console.log("Cloudant API keys coming from local");
}

// Logging parameters
LOG_DC = process.env.LOG_DC;
LOG_AUTHOR = process.env.LOG_AUTHOR;


// --------------------------------------------------------------------------
// Setup Cloudant
// --------------------------------------------------------------------------
// Initialize the library with my account.
var cloudant = Cloudant({account: CLOUDANT_USER, password: CLOUDANT_PW});

// --------------------------------------------------------------------------
// Setup the express server
// --------------------------------------------------------------------------
var app = express();

// serve the files out of ./public as our main files
app.use(express.static(__dirname + "/public"));

// create application/json parser
var jsonParser = bodyParser.json();
var urlencodedParser = bodyParser.urlencoded({extended: false});

// --------------------------------------------------------------------------
// Express Server runtime
// --------------------------------------------------------------------------
// Start our server !
app.listen(process.env.PORT || 3000, function() {
  console.log("INFO: app is listening on port %s", (process.env.PORT || 3000));

  cloudant.db.list(function(err, allDbs) {
    console.log('Checking cloudant by listing all my databases: %s', allDbs.join(', '))
  });
});

// --------------------------------------------------------------------------
// Webhook entry point
app.post("/slash", jsonParser, function(req, res) {
  // Check if we have all the required variables
  if (!APP_ID || !APP_SECRET || !APP_WEBHOOK_SECRET) {
    console.log("ERROR: Missing variables APP_ID, APP_SECRET or WEBHOOK_SECRET from environment");
    return;
  }

  // Handle Watson Work Webhook verification challenge
  if (req.body.type === 'verification') {
    console.log('Got Webhook verification challenge ' + JSON.stringify(req.body));

    var bodyToSend = {
      response: req.body.challenge
    };

    var hashToSend = crypto.createHmac('sha256', APP_WEBHOOK_SECRET).update(JSON.stringify(bodyToSend)).digest('hex');

    res.set('X-OUTBOUND-TOKEN', hashToSend);
    res.send(bodyToSend);
    return;
  }

  // Ignore all our own messages
  if (req.body.userId === APP_ID) {
    console.log("Message from myself : abort");
    res.status(200).end();
    return;
  }

  // Ignore empty messages
  if (req.body.content === "") {
    console.log("Empty message : abort");
    res.status(200).end();
    return;
  }

  // Get the event type
  var eventType = req.body.type;

  // Get the spaceId
  var spaceId = req.body.spaceId;

  // Acknowledge we received and processed notification to avoid getting
  // sent the same event again
  res.status(200).end();

  // Act only on the events we need
  if (eventType === "message-annotation-added") {
    // Get the annotation type and payload
    var annotationType = req.body.annotationType;
    var annotationPayload = JSON.parse(req.body.annotationPayload);

    // Action fulfillment callback - When user clicks and engages with App
    if (annotationType === "actionSelected") {
      var userName = req.body.userName;
      console.log("------- AF -------------------------------")
      console.log("%s issued a command.", userName);

      // Extract the necessary info
      var targetUserId = req.body.userId;
      var conversationId = annotationPayload.conversationId;
      var targetDialogId = annotationPayload.targetDialogId;
      var referralMessageId = annotationPayload.referralMessageId;
      var actionId = annotationPayload.actionId;
      console.log("Action : %s", actionId);
      console.log("Referral Message Id : %s", referralMessageId);

      // We first need to get back the annotations of the originating message to get the possible search terms.
      getAuthFromAppIdSecret(APP_ID, APP_SECRET, function(error, accessToken) {
        if (error) {
          console.log("Unable to authenticate. No results will be shown.");
        } else {
          console.log("------------------------------------");
          console.log("Starting Script generation !!!");

          // maintain the status. When something goes wrong, use it to escape the script generation
          var generationStatus = true;

          // ------------------------------------------------------------
          // Get our default lab script
          // ------------------------------------------------------------
          //console.log(labscript);

          if (!labscript.scenarioname) {
            console.log("Invalid JSON received. Aborting");
            generationStatus = false;
          }

          // Overwrite the spaceid in the script with the current spaceid
          labscript.spaceid = spaceId;
          generationStatus = processScript(labscript, null);

          // Preparing the dialog message
          var afgraphql1 = "mutation {createTargetedMessage(input: {conversationId: \"" + conversationId + "\" targetUserId: \"" + targetUserId + "\" targetDialogId: \"" + targetDialogId + "\" annotations: [{genericAnnotation: {title: \"Demo generator\" text: \"The demo generator will start building your demo in a few seconds! Your userid will also be added to the Watson Work Labs Q&A space where you can post your questions. Enjoy !\" buttons: [";
          var afgraphql3 = "]}}]}){successful}}";
          var afgraphql2 = "";

          var afgraphql = afgraphql1 + afgraphql2 + afgraphql3;

          // Send the dialog message
          postActionFulfillmentMessage(accessToken, afgraphql, function(err, accessToken) {});

          // Finally, add the user issuing the slash command to the Q&A space.
          addUserToSpace(accessToken, SPACE_ID_WWLABQA, targetUserId, function(err, accessToken) {});
        }
      });
    }
  }
});

// --------------------------------------------------------------------------
// Read the database with all users and check if they're still ok.
/*
app.get("/tst", function(req, res) {

  var appAccessToken;
  // Get the app accesstoken first
  getAuthFromAppIdSecret(APP_ID, APP_SECRET, function(err, accessToken) {

    var cefid = "515898ad-f9dd-45e4-ad8d-a5bf217219c2";
    var spaceid = "5950c636e4b0ae4e893030d2";

    if (err) {
      generationStatus = false;
      console.log("Couldn't get an App Access token - shouldn't happen.");
    }

    addUserToSpace(accessToken, spaceid, cefid, function(err, accessToken) {
      res.redirect("/");

    });
  });

});
*/
// --------------------------------------------------------------------------
// Read the database with all users and check if they're still ok.
app.post("/newuser", urlencodedParser, function(req, res) {
  console.log("------------------------------------");
  console.log("Starting new user creation !!!");

  var useremail = req.body.newuseremail;
  var refreshToken = req.body.refreshToken;

  console.log("Creating user %s with token %s.", useremail, refreshToken);

  // Get our database
  var iwwdemogenerator = cloudant.db.use("iwwdemogenerator");

  // Get the app accesstoken first
  getAuthFromAppIdSecret(APP_ID, APP_SECRET, function(err, accessToken) {

    if (err) {
      console.log("Couldn't get an App Access token - shouldn't happen.");
      res.redirect("/users.html?status=errorauth");
      return;
    }

    getUserId(accessToken, useremail, function(err, personid, personname, accessToken) {
      if (err) {
        console.log("Couldn't find user.");
        res.redirect("/users.html?status=usernotfound");
        return;
      }

      // check if we already have a record with personid as key.
      iwwdemogenerator.get(personid, {
        revs_info: false
      }, function(err, doc) {
        if (!err) {
          // We already have this user in the database
          console.log("User already in the database.");

          // Check if the refreshToken is ok
          if (doc.tokenok) {
            // We don't do nothin'
            res.redirect("/users.html?status=useralreadyindb");
            return;
          } else {
            // Update the user
            doc.refreshToken = refreshToken;
            iwwdemogenerator.insert(doc, personid, function(err, retdoc) {
              if (err) {
                console.log("Error updating db record :", err.message);
              } else {
                console.log("Refresh token updated for", doc.userName);
              }

              res.redirect("/users.html?status=userupdated");
              return;
            });
          }
        } else {
          // it's a new record.
          iwwdemogenerator.insert({
            userid: personid,
            userName: personname,
            refreshToken: refreshToken,
            email: useremail
          }, personid, function(err, body, header) {
            if (err) {
              console.log("Error adding user to database :", err.message);
              res.redirect("/users.html?status=erroraddinguser");
              return;
            }

            console.log("User added to database :", personname);
            res.redirect("/users.html");
          });
        }
      });
    })
  });
});

// --------------------------------------------------------------------------
// Read the database with all users and check if they're still ok.
app.post("/userscheck", function(req, res) {
  console.log("------------------------------------");
  console.log("Starting user check !!!");

  //set the appropriate HTTP header
  res.setHeader('Content-Type', 'text/html');

  // Get our database
  var iwwdemogenerator = cloudant.db.use("iwwdemogenerator");

  // Get all cloudant db documents
  iwwdemogenerator.list(function(err, data) {
    if (err) {
      console.log(err);
      res.write("Error getting users from database. Please notify the app owner to have a look at this.<br>");
      res.end();
      return;
    }

    var total_rows = data.total_rows;
    var users = data.rows;
    console.log("Checking " + total_rows + " users.");
    res.write("There are " + total_rows + " users in the database.<br>");
    res.write("Retrieving info and checking if they are still valid ... <br>");

    // Get the app accesstoken first
    getAuthFromAppIdSecret(APP_ID, APP_SECRET, function(err, accessToken) {

      if (err) {
        generationStatus = false;
        console.log("Couldn't get an App Access token - shouldn't happen.");
        res.write("Couldn't get an App Access token - shouldn't happen.<br>");
        res.write("Aborting script generation. Please notify the app owner to have a look at this.<br>");

        res.end();
        return;
      }

      // Loop over the user array and add the res and db object and the app access token.
      var arrayLength = users.length;
      for (var i = 0; i < arrayLength; i++) {
        users[i].res = res;
        users[i].db = iwwdemogenerator;
        users[i].appAccessToken = accessToken;
      }

      async.eachSeries(users, getUserListAndCheckAsync, function(err) {
        if (err) {
          console.log("Problem getting workspace info for some users ... strange ...");

          res.write("Problem getting workspace info for some users.<br>");
          res.write("Aborting user list generation. Please notify the app owner to have a look at this.<br>");
          res.end();
          return;
        }

        console.log("User List processing done !!!");
        res.write("User list generation complete.<br>");
        res.end();;
      });
    });
  });
});

// --------------------------------------------------------------------------
// Read the database with all users and check if they're still ok.
app.post("/userslist", function(req, res) {
  console.log("------------------------------------");
  console.log("Starting user overview !!!");

  //set the appropriate HTTP header
  res.setHeader('Content-Type', 'text/html');

  // Get our database
  var iwwdemogenerator = cloudant.db.use("iwwdemogenerator");

  // Get all cloudant db documents
  iwwdemogenerator.list(function(err, data) {
    if (err) {
      console.log(err);
      res.write("Error getting users from database. Please notify the app owner to have a look at this.<br>");
      res.end();
      return;
    }

    var total_rows = data.total_rows;
    var users = data.rows;
    res.write("There are " + total_rows + " users in the database.<br>");
    res.write("Retrieving info ... <br>");

    // Loop over the user array and add the res and db object and the app access token.
    var arrayLength = users.length;
    for (var i = 0; i < arrayLength; i++) {
      users[i].res = res;
      users[i].db = iwwdemogenerator;
    }

    async.eachSeries(users, getUserListAsync, function(err) {
      if (err) {
        console.log("Problem getting workspace info for some users ... strange ...");

        res.write("Problem getting workspace info for some users.<br>");
        res.write("Aborting user list generation. Please notify the app owner to have a look at this.<br>");
        res.end();
        return;
      }

      console.log("User List processing done !!!");
      setTimeout(function() {
        res.write("User list generation complete.<br>");
        res.end();
      }, 500);
    });
  });
});

// --------------------------------------------------------------------------
// Read the input JSON file and process
app.post("/generate", jsonParser, function(req, res) {
  console.log("------------------------------------");
  console.log("Starting JSON parsing and Script generation !!!");
  console.log("cuerpo:::::::", req.body);

  //set the appropriate HTTP header
  res.setHeader('Content-Type', 'text/html');

  // ------------------------------------------------------------
  // read the incoming JSON and make a new object.
  // ------------------------------------------------------------
  var generatorinput = req.body;
  //console.log(generatorinput);

  if (!generatorinput.scenarioname) {
    console.log("Invalid JSON received. Aborting");
    res.write("Invalid JSON received. Aborting<br>");
    res.end();
    return;
  }

  processScript(generatorinput, res);

});

// --------------------------------------------------------------------------
// App specific helper methods
// --------------------------------------------------------------------------
// Process Script
function processScript(generatorinput, res){
  console.log("Received scenario :", generatorinput.scenarioname);

  if(res){
    res.write("Received space name : " + generatorinput.scenarioname + "<br>");
  }

  // maintain the status. When something goes wrong, use it to escape the script generation
  var generationStatus = true;



  // ------------------------------------------------------------
  // LF - Create the Space and add the ID to the Script
  // ------------------------------------------------------------
  // Get the app accesstoken first

  console.log("Creating space with name: ", generatorinput.spacename);
  createDemoSpace(generatorinput.spacename, res, function(errCreatingSpace, spaceid, userAccessToken){
    if (errCreatingSpace) {
      generationStatus = false;
      console.log("Could not create the Space - shouldn't happen. EROR::", errCreatingSpace);
      if(res){
        res.write("Could not create the Space - shouldn't happen. - shouldn't happen.<br>");
        res.write("Aborting script generation. Please notify the app owner to have a look at this.<br>");
        res.end();
      }
      return false;
    } else {
      res.write("Space created with ID: " + spaceid + "<br>");
      //Configure Space with Expertfinder
      configDemoSpace(spaceid, function(errConfiguringSpace){
        if(errConfiguringSpace){
          generationStatus = false;
          console.log("Could not configure the Expertfinder for the Space - shouldn't happen. EROR::", errCreatingSpace);
          if(res){
            res.write("Could not configure the Expertfinder for the Space - shouldn't happen.<br>");
            res.write("Aborting script generation. Please notify the app owner to have a look at this.<br>");
            res.end();
          }
          return false;
        } else {
          res.write("Expertfinder configured for the new space.<br>");
          //Add apps to space
          //Adding spaceid and userAccessToken to the users and apps of the demo
          console.log("Adding Demo Generator App and Health Bot to Space");
          var appsAndUsers = JSON.parse(fs.readFileSync('./public/resources/appsAndUsers.json', 'utf8'));

          console.log("Demo apps and users: ", appsAndUsers);
          var arrayLength = appsAndUsers.users.length;
          for (var i = 0; i < arrayLength; i++) {
            appsAndUsers.users[i].spaceid = spaceid;
            appsAndUsers.users[i].appAccessToken = userAccessToken;
          }

          async.each(appsAndUsers.users, addUserToSpaceAsync, function(errAddingDemoApps) {
            if (errAddingDemoApps) {
              generationStatus = false;
              console.log("Couldn't add Paciente Estable and Health Bot apps to space.");
              if(res){
                res.write("Couldn't add Paciente Estable and Health Bot apps to space.<br>");
                res.write("Aborting script generation. Please notify the app owner to have a look at this.<br>");
                res.end();
              }
              return false;
            } else {
              // We have all the apps needed in the Demos, lets process the script
              console.log("Health Bot and Ingreso Paciente Apps Added to Space !");

              var script = generatorinput.script;
              //var spaceid = generatorinput.spaceid;
              var applist = generatorinput.apps;

              // ------------------------------------------------------------
              // Step 2 : Get all userids, make sure all have valid workspace accounts.
              // ------------------------------------------------------------

              var appAccessToken;
              // Get the app accesstoken first
              getAuthFromAppIdSecret(APP_ID, APP_SECRET, function(err, accessToken) {

                if (err) {
                  generationStatus = false;
                  console.log("Couldn't get an App Access token - shouldn't happen.");
                  if(res){
                    res.write("Couldn't get an App Access token - shouldn't happen.<br>");
                    res.write("Aborting script generation. Please notify the app owner to have a look at this.<br>");
                    res.end();
                  }
                  return false;
                }

                appAccessToken = accessToken;

                // Already add the spaceid, appAccessToken and response to each object in the script as we'll need it later on
                var arrayLength = script.length;
                for (var i = 0; i < arrayLength; i++) {
                  script[i].email = DEMO_USER_EMAIL;
                  script[i].spaceid = spaceid;
                  script[i].appAccessToken = appAccessToken;
                  script[i].res = res;
                }

                // Adjust the applist also
                if (applist) {
                  var appArrayLength = applist.length;
                  for (var i = 0; i < appArrayLength; i++) {
                    applist[i].spaceid = spaceid;
                    applist[i].appAccessToken = appAccessToken;
                    applist[i].userid = applist[i].appid;
                    applist[i].userName = applist[i].appname;
                  }
                }

                // Get all the workspace userids from the email addresses. If not all have ids, escape the generator
                // Using async to issue all requests in parallel, but wait until all are there.
                var useridTokenMap = {};
                async.eachSeries(script, getUserIdAsync.bind(null, useridTokenMap), function(err) {
                  if (err) {
                    generationStatus = false;
                    console.log("Couldn't get one or more userids from the email addresses.");
                    if(res){
                      res.write("Couldn't get one or more userids from the email addresses.<br>");
                      res.write("Aborting script generation. Please make sure all the users in your script have valid Workspace accounts.<br>");
                      res.end();
                    }
                    return false;
                  }

                  // We have all userids, so all users have workspace accounts. Let's continue !
                  console.log("All users have workspace ids ! Great !");
                  if(res){
                    res.write("All users have workspace ids ! Great !<br>");
                  }

                  // ------------------------------------------------------------
                  // Step 3 : Generate all the access tokens from the refreshtoken, make sure we have them all before Starting
                  // ------------------------------------------------------------
                  // Store the accesstokens in a temporary map, so that we only need to get them once for every user
                  var accessTokenMap = {};
                  async.eachSeries(script, getAccessTokenAsync.bind(null, accessTokenMap), function(err) {
                    if (err) {
                      generationStatus = false;
                      console.log("Couldn't get one or more refreshTokens from the database.");
                      if(res){
                        res.write("Couldn't get one or more refreshTokens from the database.<br>");
                        res.write("Aborting script generation. Please make sure all users in your script have access tokens in the database.<br>");
                        res.write("You can check that <a href='/users.html'>here</a>.<br>");
                        res.end();
                      }
                      return false;
                    }

                    // We have all userids, so all users have workspace accounts. Let's continue !
                    console.log("We have access tokens for all users.");
                    if(res){
                      res.write("We have authentication tokens for all users. Perfect !!!!!!<br>");
                    }

                    // ------------------------------------------------------------
                    // Step 4 : Add all users and apps to the space
                    // ------------------------------------------------------------

                    async.each(script, addUserToSpaceAsync, function(err) {
                      if (err) {
                        generationStatus = false;
                        console.log("Couldn't add one or more users to the space");
                        if(res){
                          res.write("Couldn't add one or more users to the space<br>");
                          res.write("Aborting script generation. Please check these items :<br>");
                          res.write("- You are working with <a href='https://workspace.ibm.com/space/" + spaceid + "' target='_blank'>this</a> space. Make sure it exists.<br>");
                          res.write("- Make sure the Demo Generator App has been added to the space<br>");
                          res.write("If all of the above is in place, please notify the app owner to have a look at this.<br>");
                          res.end();
                        }
                        return false;
                      }

                      async.each(applist, addUserToSpaceAsync, function(err) {
                        if (err) {
                          generationStatus = false;
                          console.log("Couldn't add one or more apps to the space");
                          if(res){
                            res.write("Couldn't add one or more apps to the space<br>");
                            res.write("Please check after the script execution if all the apps you need are there.<br>");
                          }
                        }

                        // We have all userids, so all users have workspace accounts. Let's continue !
                        console.log("All demo users and apps added to the space. Check !");
                        if(res){
                          res.write("All demo users and apps added to the space. Check ! ");
                        }

                        // ------------------------------------------------------------
                        // Step 5 : Push the script to the space.
                        // ------------------------------------------------------------
                        console.log("------ Starting Script ---------");
                        if(res){
                          res.write("Starting to write the script to the space ...<br>");
                        }
                        async.eachSeries(script, postMessageAsyncHack, function(err) {
                          if (err) {
                            generationStatus = false;
                            console.log("Error writing to the space");
                            if(res){
                              res.write("Some users couldn't write to the space<br>");
                              res.write("Aborting script generation. Please notify the app owner to have a look at this.<br>");
                              res.end();
                            }
                            return false;
                          }

                          console.log("Script processing done !!!");
                          if(res){
                            setTimeout(function() {
                              res.write("... script processing done !!!<br>");
                              res.end();;
                            }, 500);
                          }
                        });
                      });
                    });
                  });
                });
              });
            }
          });
        }
      });

      /*var apps = [
        {
          "userName": "Health Bot",
          "userid": "d7dda23b-9831-47f8-a76b-ec2979a20ddb",
          "appAccessToken": userAccessToken,
          "spaceid": spaceid
        },
        {
          "userName": "Paciente Estable",
          "userid": APP_ID,
          "appAccessToken": userAccessToken,
          "spaceid": spaceid
        }
      ];*/


      /*
      console.log("Adding Demo Generator App to Space");
      addUserToSpace(userAccessToken, spaceid, APP_ID, function(errAddingDemoGeneratorAppToSpace, appAccessToken){
        if (errAddingDemoGeneratorAppToSpace){
          generationStatus = false;
          console.log("Could not add Demo Generator App to Space - shouldn't happen. EROR::", errAddingDemoGeneratorAppToSpace);
          if(res){
            res.write("Could not add Demo Generator App to Space - shouldn't happen.<br>");
            res.write("Aborting script generation. Please notify the app owner to have a look at this.<br>");
            res.end();
          }
          return false;
        } else {
          console.log("Demo Generator App Added to Space.");
          res.write("Demo Generator App Added to Space!!!<br>");
          if(res){
            setTimeout(function() {
              res.write("... script processing done !!!<br>");
              res.end();;
            }, 500);
          }
        }
      });*/
    }
  });
}

// --------------------------------------------------------------------------
// Check the user list from the database to print and check validitiy refreshToken
function getUserListAsync(item, callback) {
  // check if we have this user in our database.
  item.db.get(item.id, {
    revs_info: false
  }, function(err, doc) {
    if (!err) {
      console.log("Found an entry in the database for", doc.userName);

      // Let's print the user info:
      var tokenokvalue = "NO";
      var refreshdate = '<button id="updateuser' + item.id + '" type="button" cust-attr-email="' + doc.email + '" class="btn btn-outline-primary btn-sm updateuser" data-toggle="modal" data-target="#NewUserModal">Update</button>';
      if (doc.tokenok) {
        tokenokvalue = "Likely";
        var tempdate = new Date(doc.refreshdate);
        refreshdate = tempdate.toDateString();
      }

      var rowstart = '<tr>';

      // Let's delay the write a little bit, when it's too fast, the table buildup gets screwed up.
      setTimeout(function() {
        console.log("Waiting half a second ...");
        if (item.res) {
          item.res.write(rowstart + "<td>" + doc.userName + "</td><td>" + doc.email + "</td><td>" + doc.userid + "</td><td>" + tokenokvalue + "</td><td>" + refreshdate + "</td></tr>");
        }
        callback();
      }, 500);
    } else {
      console.log("No entry in the database for", item.id);
      if (item.res) {
        item.res.write("Issue detected : no entry in the database for " + item.id + "<br>");
      }
      callback(err);
    }
  });
}

// --------------------------------------------------------------------------
// Check the user list from the database to print and check validitiy refreshToken
function getUserListAndCheckAsync(item, callback) {
  // check if we have this user in our database.
  item.db.get(item.id, {
    revs_info: false
  }, function(err, doc) {
    if (!err) {
      console.log("Checking", doc.userName);

      // Init printing values.
      var tokenokvalue = "NOT OK";
      var rowstart = '<tr class="bg-danger">';
      var refreshdate = '<button id="updateuser' + item.id + '" type="button" cust-attr-email="' + doc.email + '" class="btn btn-outline-primary btn-sm updateuser" data-toggle="modal" data-target="#NewUserModal">Update</button>';

      // get the accesstoken
      getAuthFromRefreshTokenHack(doc.refreshToken, function(err2, accessToken, refreshToken, userName, userid) {
        if (err2) {
          console.log("Couldn't get accessToken for", item.id);
          doc.tokenok = false;
        } else {
          console.log("Got token for", userName);
          doc.refreshToken = refreshToken;
          doc.userName = userName;
          doc.tokenok = true;
          doc.refreshdate = new Date();

          tokenokvalue = "OK";
          rowstart = '<tr class="bg-success">';
          refreshdate = doc.refreshdate.toDateString();
        }

        // Let's print the user info:
        if (item.res) {
          item.res.write(rowstart + "<td>" + doc.userName + "</td><td>" + doc.email + "</td><td>" + doc.userid + "</td><td>" + tokenokvalue + "</td><td>" + refreshdate + "</td></tr>");
        }

        // Last step : update the database
        item.db.insert(doc, item.id, function(err, retdoc) {
          if (err) {
            console.log("Error adding refreshtoken to database :", err.message);
          } else {
            console.log("Refresh token updated for", doc.userName);
          }
          callback();
        });
      });

    } else {
      console.log("No entry in the database for", item.id);
      if (item.res) {
        item.res.write("Issue detected : no entry in the database for " + item.id + "<br>");
      }
      callback(err);
    }
  });
}

//---------------------------------------------------------------------------
function getAccessTokenAsync(accessTokenMap, item, callback) {
  console.log("getAccessTokenAsync for", item.email);

  // This function can also be used without and accessTokenMap, so check if there is one
  if (accessTokenMap) {
    // Check if we already have the user.
    if (item.userid in accessTokenMap) {
      console.log("We already have the accessToken for user", item.email);
      item.accessToken = accessTokenMap[item.userid];
      callback();
      return;
    }
  }

  // Get the refreshToken from our database
  var iwwdemogenerator = cloudant.db.use("iwwdemogenerator");

  // check if we have this user in our database.
  iwwdemogenerator.get(item.userid, {
    revs_info: false
  }, function(err, doc) {
    if (!err) {
      console.log("Found a refreshToken in the database for", item.email);
      if (item.res) {
        item.res.write("There is a refreshToken in the database for " + item.email + "<br>");
      }

      // get the accesstoken
      getAuthFromRefreshTokenHack(doc.refreshToken, function(err, accessToken, refreshToken, userName, userid) {
        if (err) {
          console.log("Couldn't get accessToken for", item.email);
          if (item.res) {
            item.res.write("Issue detected : couldn't get an accessToken for " + item.email + "<br>");
            item.res.write("Could be a known issue : the API sometimes returnes an error even if the refreshToken is ok.<br>");
            item.res.write("Just run the script again. If the error remains, the refreshToken will probably have to be updated.<br>");
          }
          callback(err);
        } else {
          console.log("got token for", userName);
          if (item.res) {
            item.res.write("Authentication token created for " + userName + "<br>");
          }
          item.accessToken = accessToken;
          item.userName = userName;
          accessTokenMap[item.userid] = accessToken;
          doc.refreshToken = refreshToken;
          doc.userName = userName;
          doc.tokenok = true;
          doc.refreshdate = new Date();
          callback();

          // Last step : update the database
          iwwdemogenerator.insert(doc, item.userid, function(err, retdoc) {
            if (err) {
              console.log("Error adding refreshtoken to database :", err.message);
            } else {
              console.log("Refresh token updated for", doc.userName);
            }
          });

        }

      });

    } else {
      console.log("No refreshToken in the database for", item.email);
      if (item.res) {
        item.res.write("Issue detected : no refreshToken in the database for " + item.email + "<br>");
      }
      var err = new Error();
      callback(err);
      return;
    }
  });
}

// --------------------------------------------------------------------------
function postMessageAsyncHack(item, callback) {
  // Check the action
  switch (item.action) {
    case "text":
      // Add the Body of the mail to the space
      postMessageToSpaceHack(item.accessToken, item.spaceid, item.text, function(err, success, jwt) {
        console.log(item.userName + " : " + item.text);
        if (item.res) {
          item.res.write(item.userName + " : " + item.text + "<br>");
        }
        if (err) {
          callback(err);
        } else {
          callback();
        }
      });
      break;
    case "file":
      if (item.res) {
        item.res.write(item.userName + " : posting file " + item.filename + " ...<br>");
      }
      // Add the file to the space
      postFileToSpace(item.accessToken, item.spaceid, item.url, item.filename, false, null, function(err) {
        console.log(item.userName + " : posting file " + item.filename);
        if (item.res) {
          item.res.write(item.userName + " : file posted.<br>");
        }
        if (err) {
          callback(err);
        } else {
          callback();
        }
      });
      break;
    case "image":
      if (item.res) {
        item.res.write(item.userName + " : posting image " + item.filename + " ...<br>");
      }
      // Add the image to the space
      postFileToSpace(item.accessToken, item.spaceid, item.url, item.filename, true, item.dim, function(err) {
        console.log(item.userName + " : posting image " + item.filename);
        if (item.res) {
          item.res.write(item.userName + " : image posted.<br>");
        }
        if (err) {
          callback(err);
        } else {
          callback();
        }
      });
      break;
    default:
      console.log("Unsupported action : ", item.action);
      if (item.res) {
        item.res.write(item.userName + " : Unsupported action : " + item.action + ". Skipping.<br>");
      }
      callback();
  }
}

//--------------------------------------------------------------------------
//Post a file to a space - url needs to be public (unauthenticated) - only tested with Box 'shared as link' url.
function postFileToSpace(accessToken, spaceId, dlurl, dlfilename, isImage, imgdim, callback) {

  var dlpath = "./public/resources/";
  var writeStream = fs.createWriteStream(dlpath + dlfilename);

  // Download the file
  console.log("Starting Download from Box ...");
  var dlstream = request.get(dlurl).on('response', function(response) {
    // Download finished, check status code
    console.log("Download returning status code", response.statusCode) // should be 200
    console.log("Downloading file type", response.headers['content-type']) // e.g. 'image/png'
  }).on('error', function(err) {
    // Hm, something went wrong
    console.log(err);
    callback(err);
  }).pipe(writeStream);

  // Let's catch the time when the download finishes ...
  dlstream.on('finish', function() {
    console.log("Download finished");

    // Upload to WS
    var formData = {
      // Pass data via Streams
      file: fs.createReadStream(dlpath + dlfilename)
    };

    // Build the file upload request
    var uploadurl = WWS_URL + "/v1/spaces/" + spaceId + "/files";
    if (isImage) {
      uploadurl += "?dim=" + imgdim;
    }
    const ReqOptions = {
      "url": uploadurl,
      "headers": {
        "jwt": accessToken
      },
      "method": "POST",
      "formData": formData
    };

    request(ReqOptions, function(err, response, body) {
      var jsonBody = JSON.parse(body);
      if (err) {
        console.error('Upload failed:', err);
        callback(err);
      }
      if (jsonBody.error) {
        console.error('Upload failed:', jsonBody.error, jsonBody.message);
        callback(err);
      }
      console.log("%s uploaded successfully. Size : %s bytes.", jsonBody.name, jsonBody.size);

      // Now let's clean up the file.
      console.log("Going to delete the file");
      fs.unlink(dlpath + dlfilename, function(err) {
        if (err) {
          console.error(err);
        } else {
          console.log("File deleted successfully!");
        }
        callback(null);
      });
    });
  });
}
//});

// --------------------------------------------------------------------------
// Health Demo Functions
// --------------------------------------------------------------------------
//  __         _________
// |  |       |   ______|
// |  |       |  |___
// |  |       |   ___|
// |  |       |  |
// |  |____   |  |
// |_______|  |__|
//
// --------------------------------------------------------------------------

//--------------------------------------------------------------------------
//Create Health Demo Space
function createDemoSpace(spacename, res, callback){
  console.log("------------------------------------");
  console.log("Starting patient admission!!!");

  //set the appropriate HTTP header
  //res.setHeader('Content-Type', 'text/html');

  getAuthFromAppIdSecret(APP_ID, APP_SECRET, function(err, accessToken) {

    if (err) {
      console.log("Couldn't get an App Access token - shouldn't happen.");
      res.write("Could not find user" + useremail +"<br>");
      return;
    }

    getUserId(accessToken, DEMO_USER_EMAIL, function(err, personid, personname, accessToken) {
      if (err) {
        console.log("Couldn't find user.");
        res.write("Could not find user" + useremail +"<br>");
        return;
      } else {
        res.write("User ID found for " + useremail+ ", Id : "+ personid + "<br>");
        console.log("User ID found for ", useremail, ", Id : ", personid);

        // Get our database
        var iwwdemogenerator = cloudant.db.use("iwwdemogenerator");

        //Get the user refreshToken
        iwwdemogenerator.get(personid,{}, function(err, user){
          if (err) {
            console.log(err);
            callback("Error getting user from database. Please notify the app owner to have a look at this, Error: " + err, null);
            //res.write("Error getting user from database. Please notify the app owner to have a look at this.<br>");
            //res.end();
            //return;
          }

          if (!user.refreshToken){
            console.log(err);
            callback("Error getting refresh Token, user not found!!");
          }

          //console.log("Got Sonia Lopez Refresh Token:", user.refreshToken);

          getAuthFromRefreshTokenHack(user.refreshToken, function(err2, accessToken, refreshToken, userName, userid) {
            if (err2) {
              console.log("Couldn't get accessToken for", user.userName);
              callback("Error getting accessToken for " + user.userName + ", Error::" + err2, null);
              //res.write("Error getting accessToken for " + user.userName + ".<br>");
              //res.end();
            } else {
              console.log("Got token for", userName);
              user.refreshToken = refreshToken;
              user.userName = userName;
              user.tokenok = true;
              user.refreshdate = new Date();

              //Create Space
              createNewSpace(accessToken, spacename, function(err3, spaceid, accessToken){
                if(!err3){
                  console.log("Space Created with ID:", spaceid);
                  callback(null, spaceid, accessToken);
                }
                else {
                  console.log("Couldn't create the Space, Error:::", err3);
                  callback("Couldn't create the Space, Error:::" + err3);
                  //res.write("Couldn't create the Space, Error:::" + err3 + ".<br>");
                  //res.end();
                }
              });

              // Last step : update the database
              iwwdemogenerator.insert(user, user.userid, function(err, retdoc) {
                if (err) {
                  console.log("Error adding refreshtoken to database :", err.message);
                } else {
                  console.log("Refresh token updated for", user.userName);
                }
              });

            }
          });
        });
      }
    });
  });

}

//--------------------------------------------------------------------------
// Config space with showcase org
function configDemoSpace(spaceid, callback){
  console.log("------------------------------------");
  console.log("Configuring the Space: ", spaceid);

  // Get our database
  var db = cloudant.db.use("expertfinder");

  //Create record
  db.insert({
    spaceid: spaceid,
    targetenv: "SC"
  }, spaceid, function(err, body, header) {
    if (err) {
      console.log("Error createing the configuration record on Cloudan Expertfinder :", err.message);
      callback(err);
      return;
    }

    console.log("Space configured in Expertfinder DB");
    callback(null);
  });

}

// --------------------------------------------------------------------------
// Generic helper methods (can be reused in other apps)
// --------------------------------------------------------------------------
//
//   _______  _______ .__   __.  _______ .______       __    ______
//  /  _____||   ____||  \ |  | |   ____||   _  \     |  |  /      |
// |  |  __  |  |__   |   \|  | |  |__   |  |_)  |    |  | |  ,----'
// |  | |_ | |   __|  |  . `  | |   __|  |      /     |  | |  |
// |  |__| | |  |____ |  |\   | |  |____ |  |\  \----.|  | |  `----.
//  \______| |_______||__| \__| |_______|| _| `._____||__|  \______|
//
// --------------------------------------------------------------------------
// GraphQL Create new Space
function callGraphQL(accessToken, graphQLbody, callback) {
  // Build the GraphQL request
  const GraphQLOptions = {
    "url": `${WWS_URL}/graphql`,
    "headers": {
      "Content-Type": "application/graphql",
      "x-graphql-view": "PUBLIC",
      "jwt": accessToken
    },
    "method": "POST",
    "body": ""
  };

  GraphQLOptions.headers.jwt = accessToken;
  GraphQLOptions.body = graphQLbody;

  // Create the space
  request(GraphQLOptions, function(err, response, graphqlbody) {
    if (!err && response.statusCode === 200) {
      //console.log(graphqlbody);
      var bodyParsed = JSON.parse(graphqlbody);
      callback(null, bodyParsed, accessToken);
    } else if (response.statusCode !== 200) {
      console.log("ERROR: didn't receive 200 OK status, but :" + response.statusCode);
      var error = new Error("");
      callback(error, null, accessToken);
    } else {
      console.log("ERROR: Can't retrieve " + GraphQLOptions.body + " status:" + response.statusCode);
      var error = new Error("");
      callback(error, null, accessToken);
    }
  });
}

// --------------------------------------------------------------------------
// GraphQL Create new Space
function createNewSpace(accessToken, spacename, callback) {
  // Build the GraphQL request
  const GraphQLOptions = {
    "url": `${WWS_URL}/graphql`,
    "headers": {
      "Content-Type": "application/graphql",
      "x-graphql-view": "PUBLIC",
      "jwt": accessToken
    },
    "method": "POST",
    "body": ""
  };

  GraphQLOptions.headers.jwt = accessToken;
  GraphQLOptions.body = "mutation createSpace{createSpace(input:{title:\"" + spacename + "\",members: [\"\"]}){space {id}}}";

  // Create the space
  request(GraphQLOptions, function(err, response, graphqlbody) {
    if (!err && response.statusCode === 200) {
      //console.log(graphqlbody);
      var bodyParsed = JSON.parse(graphqlbody);

      if (bodyParsed.data.createSpace) {
        var spaceid = bodyParsed.data.createSpace.space.id;
        console.log("Space created with ID", spaceid);
        callback(null, spaceid, accessToken);

      } else {
        var error = new Error("");
        callback(error, null, accessToken);
      }

    } else if (response.statusCode !== 200) {
      console.log("ERROR: didn't receive 200 OK status, but :" + response.statusCode);
      var error = new Error("");
      callback(error, null, accessToken);
    } else {
      console.log("ERROR: Can't retrieve " + GraphQLOptions.body + " status:" + response.statusCode);
      var error = new Error("");
      callback(error, null, accessToken);
    }
  });
}

// --------------------------------------------------------------------------
// graphQL Get Userid from mail
function getUserId(accessToken, email, callback) {
  // Build the GraphQL request
  const GraphQLOptions = {
    "url": `${WWS_URL}/graphql`,
    "headers": {
      "Content-Type": "application/graphql",
      "x-graphql-view": "PUBLIC",
      "jwt": "${jwt}"
    },
    "method": "POST",
    "body": ""
  };

  GraphQLOptions.headers.jwt = accessToken;
  GraphQLOptions.body = "query getProfile{person(email:\"" + email + "\") {id displayName}}";

  request(GraphQLOptions, function(err, response, graphqlbody) {

    if (!err && response.statusCode === 200) {
      //console.log(graphqlbody);
      var bodyParsed = JSON.parse(graphqlbody);
      if (bodyParsed.data.person) {

        var personid = bodyParsed.data.person.id;
        var personname = bodyParsed.data.person.displayName;
        console.log("Found user : " + personname + ", ID = " + personid);
        callback(null, personid, personname, accessToken);
      } else {
        var error = new Error("");
        callback(error, "Sorry, can't find that user.", null, accessToken);
      }

    } else if (response.statusCode !== 200) {
      console.log("ERROR: didn't receive 200 OK status, but :" + response.statusCode);
      var error = new Error("");
      callback(error, null, null, accessToken);
    } else {
      console.log("ERROR: Can't retrieve " + GraphQLOptions.body + " status:" + response.statusCode);
      callback(err, null, null, accessToken);
    }
  });
}

// --------------------------------------------------------------------------
// graphQL Get Userinfo (name & email) from ID
function getUserFromId(accessToken, userid, callback) {
  // Build the GraphQL request
  const GraphQLOptions = {
    "url": `${WWS_URL}/graphql`,
    "headers": {
      "Content-Type": "application/graphql",
      "x-graphql-view": "PUBLIC",
      "jwt": "${jwt}"
    },
    "method": "POST",
    "body": ""
  };

  GraphQLOptions.headers.jwt = accessToken;
  GraphQLOptions.body = "query getProfile{person(id:\"" + userid + "\") {email displayName}}";

  request(GraphQLOptions, function(err, response, graphqlbody) {

    if (!err && response.statusCode === 200) {
      //console.log(graphqlbody);
      var bodyParsed = JSON.parse(graphqlbody);
      if (bodyParsed.data.person) {

        var personmail = bodyParsed.data.person.email;
        var personname = bodyParsed.data.person.displayName;
        console.log("Found user : " + personname + ", Mail = " + personmail);
        callback(null, personname, personmail, accessToken);
      } else {
        var error = new Error("");
        callback(error, "Sorry, can't find that user.", null, accessToken);
      }

    } else if (response.statusCode !== 200) {
      console.log("ERROR: didn't receive 200 OK status, but :" + response.statusCode);
      var error = new Error("");
      callback(error, null, null, accessToken);
    } else {
      console.log("ERROR: Can't retrieve " + GraphQLOptions.body + " status:" + response.statusCode);
      callback(err, null, null, accessToken);
    }
  });
}

// --------------------------------------------------------------------------
// graphQL Get Userid from mail for use with async
// 'item' needs to have props email and appAccessToken, userid will be added
function getUserIdAsync(useridTokenMap, item, callback) {
  // This function can also be used without and accessTokenMap, so check if there is one
  if (useridTokenMap) {
    // Check if we already have the user.
    if (item.email in useridTokenMap) {
      console.log("We already checked user", item.email);
      item.userid = useridTokenMap[item.email].userid;
      item.userName = useridTokenMap[item.email].userName;
      callback();
      return;
    }
  }

  // Build the GraphQL request
  const GraphQLOptions = {
    "url": `${WWS_URL}/graphql`,
    "headers": {
      "Content-Type": "application/graphql",
      "x-graphql-view": "PUBLIC",
      "jwt": "${jwt}"
    },
    "method": "POST",
    "body": ""
  };
  console.log("getUserIdAsync for", item.email);

  GraphQLOptions.headers.jwt = item.appAccessToken;
  GraphQLOptions.body = "query getProfile{person(email:\"" + item.email + "\") {id displayName}}";

  request(GraphQLOptions, function(err, response, graphqlbody) {

    if (!err && response.statusCode === 200) {
      //console.log(graphqlbody);
      var bodyParsed = JSON.parse(graphqlbody);
      if (bodyParsed.data.person) {

        var personid = bodyParsed.data.person.id;
        var personname = bodyParsed.data.person.displayName;
        console.log("Found user : " + personname + ", ID = " + personid);
        if (item.res) {
          item.res.write("Workspace user check ok for : " + personname + ", ID = " + personid + "<br>");
        }
        item.userid = personid;
        item.userName = personname;
        useridTokenMap[item.email] = {
          "userid": personid,
          "userName": personname
        };
        callback();
      } else {
        var error = new Error("");
        callback(error, "Sorry, can't find that user.");
      }

    } else if (response.statusCode !== 200) {
      console.log("ERROR: didn't receive 200 OK status, but :" + response.statusCode);
      var error = new Error("");
      callback(error, "Received status code " + response.statusCode);
    } else {
      console.log("ERROR: Can't retrieve " + GraphQLOptions.body + " status:" + response.statusCode);
      callback(err, null);
    }
  });
}

// --------------------------------------------------------------------------
// graphQL Get User from ID for use with async
// 'item' needs to have props userid and appAccessToken, userName and email will be added
function getUserFromIdAsync(item, callback) {
  // Build the GraphQL request
  const GraphQLOptions = {
    "url": `${WWS_URL}/graphql`,
    "headers": {
      "Content-Type": "application/graphql",
      "x-graphql-view": "PUBLIC",
      "jwt": "${jwt}"
    },
    "method": "POST",
    "body": ""
  };
  console.log("getUserFromIdAsync for", item.id);

  GraphQLOptions.headers.jwt = item.appAccessToken;
  GraphQLOptions.body = "query getProfile{person(id:\"" + item.id + "\") {email displayName}}";

  request(GraphQLOptions, function(err, response, graphqlbody) {

    if (!err && response.statusCode === 200) {
      //console.log(graphqlbody);
      var bodyParsed = JSON.parse(graphqlbody);
      if (bodyParsed.data.person) {

        var email = bodyParsed.data.person.email;
        var personname = bodyParsed.data.person.displayName;
        console.log("Found user : " + personname + ", email = " + email);
        item.email = email;
        item.userName = personname;
        callback();
      } else {
        var error = new Error("");
        callback(error, "Sorry, can't find that user.");
      }

    } else if (response.statusCode !== 200) {
      console.log("ERROR: didn't receive 200 OK status, but :" + response.statusCode);
      var error = new Error("");
      callback(error, "Received status code " + response.statusCode);
    } else {
      console.log("ERROR: Can't retrieve " + GraphQLOptions.body + " status:" + response.statusCode);
      callback(err, null);
    }
  });
}

// --------------------------------------------------------------------------
// graphQL Get a list of spaces
function getSpaces(accessToken, callback) {
  // Build the GraphQL request
  const GraphQLOptions = {
    "url": `${WWS_URL}/graphql`,
    "headers": {
      "Content-Type": "application/graphql",
      "x-graphql-view": "PUBLIC",
      "jwt": "${jwt}"
    },
    "method": "POST",
    "body": ""
  };

  GraphQLOptions.headers.jwt = accessToken;
  GraphQLOptions.body = "query getSpaces {spaces(first:200) {items {title id}}}";

  console.log("Calling GraphQL query getSpaces");
  request(GraphQLOptions, function(err, response, graphqlbody) {

    if (!err && response.statusCode === 200) {
      var bodyParsed = JSON.parse(graphqlbody);
      if (bodyParsed.data.spaces) {
        console.log("Got list of spaces");
        callback(null, bodyParsed.data.spaces, accessToken);
      } else {
        console.log("Graphql not returning any spaces, dumping return :");
        console.log(graphqlbody);
        var error = new Error("");
        callback(error, "error getting spaces", accessToken);
      }

    } else if (response.statusCode !== 200) {
      console.log("ERROR: didn't receive 200 OK status, but :" + response.statusCode);
      var error = new Error("");
      callback(error, null, accessToken);
    } else {
      console.log("ERROR: Can't retrieve " + GraphQLOptions.body + " status:" + response.statusCode);
      var error = new Error("");
      callback(err, null, accessToken);
    }
  });
}

//--------------------------------------------------------------------------
//graphQL Add user to Space
function addUserToSpace(accessToken, spaceid, userid, callback) {

  // Build the GraphQL request
  const GraphQLOptions = {
    "url": `${WWS_URL}/graphql`,
    "headers": {
      "Content-Type": "application/graphql",
      "x-graphql-view": "PUBLIC",
      "jwt": "${jwt}"
    },
    "method": "POST",
    "body": ""
  };

  GraphQLOptions.headers.jwt = accessToken;
  GraphQLOptions.body = "mutation updateSpaceAddMembers{updateSpace(input: { id: \"" + spaceid + "\",  members: [\"" + userid + "\"], memberOperation: ADD}){memberIdsChanged space {title membersUpdated members {items {id email displayName}}}}}";

  request(GraphQLOptions, function(err, response, graphqlbody) {

    if (!err && response.statusCode === 200) {
      //console.log(graphqlbody);
      var bodyParsed = JSON.parse(graphqlbody);
      callback(null, accessToken);
    } else if (response.statusCode !== 200) {
      console.log("ERROR: didn't receive 200 OK status, but :" + response.statusCode);
      var error = new Error("");
      callback(error, accessToken);
    } else {
      console.log("ERROR: Can't retrieve " + GraphQLOptions.body + " status:" + response.statusCode);
      callback(err, accessToken);
    }
  });
}

//--------------------------------------------------------------------------
//graphQL Add user to Space
function addDemoUserToSpaceAsync(item, spaceid, userAccessToken, callback) {
  // Build the GraphQL request
  const GraphQLOptions = {
    "url": `${WWS_URL}/graphql`,
    "headers": {
      "Content-Type": "application/graphql",
      "x-graphql-view": "PUBLIC",
      "jwt": "${jwt}"
    },
    "method": "POST",
    "body": ""
  };

  GraphQLOptions.headers.jwt = item.userAccessToken;
  GraphQLOptions.body = "mutation updateSpaceAddMembers{updateSpace(input: { id: \"" + item.spaceid + "\",  members: [\"" + item.userid + "\"], memberOperation: ADD}){memberIdsChanged space {title membersUpdated members {items {id email displayName}}}}}";

  request(GraphQLOptions, function(err, response, graphqlbody) {

    if (!err && response.statusCode === 200) {
      //console.log(graphqlbody);
      var bodyParsed = JSON.parse(graphqlbody);
      if (!bodyParsed.errors) {
        console.log(item.userName + " added to space.");
        callback();
      } else {
        console.log(item.userName + " not added to space : " + bodyParsed.errors[0].message);
        var err = new Error();
        callback(err);
      }
    } else if (response.statusCode !== 200) {
      console.log("ERROR: didn't receive 200 OK status, but :" + response.statusCode);
      var error = new Error("");
      callback(error);
    } else {
      console.log("ERROR: Can't retrieve " + GraphQLOptions.body + " status:" + response.statusCode);
      callback(err);
    }
  });
}

//--------------------------------------------------------------------------
//graphQL Add user to Space
function addUserToSpaceAsync(item, callback) {
  // Build the GraphQL request
  const GraphQLOptions = {
    "url": `${WWS_URL}/graphql`,
    "headers": {
      "Content-Type": "application/graphql",
      "x-graphql-view": "PUBLIC",
      "jwt": "${jwt}"
    },
    "method": "POST",
    "body": ""
  };

  GraphQLOptions.headers.jwt = item.appAccessToken;
  GraphQLOptions.body = "mutation updateSpaceAddMembers{updateSpace(input: { id: \"" + item.spaceid + "\",  members: [\"" + item.userid + "\"], memberOperation: ADD}){memberIdsChanged space {title membersUpdated members {items {id email displayName}}}}}";

  request(GraphQLOptions, function(err, response, graphqlbody) {

    if (!err && response.statusCode === 200) {
      //console.log(graphqlbody);
      var bodyParsed = JSON.parse(graphqlbody);
      if (!bodyParsed.errors) {
        console.log(item.userName + " added to space.");
        callback();
      } else {
        console.log(item.userName + " not added to space : " + bodyParsed.errors[0].message);
        var err = new Error();
        callback(err);
      }
    } else if (response.statusCode !== 200) {
      console.log("ERROR: didn't receive 200 OK status, but :" + response.statusCode);
      var error = new Error("");
      callback(error);
    } else {
      console.log("ERROR: Can't retrieve " + GraphQLOptions.body + " status:" + response.statusCode);
      callback(err);
    }
  });
}

//--------------------------------------------------------------------------
//Post a message to a space
function postMessageToSpace(accessToken, spaceId, textMsg, callback) {
  var jsonClient = requestjs.createClient(WWS_URL);
  var urlToPostMessage = "/v1/spaces/" + spaceId + "/messages";
  jsonClient.headers.jwt = accessToken;

  // Building the message
  var messageData = {
    type: "appMessage",
    version: 1.0,
    annotations: [
      {
        type: "generic",
        color: "#ffffff",
        version: 1.0,
        text: textMsg
      }
    ]
  };

  // Calling IWW API to post message
  jsonClient.post(urlToPostMessage, messageData, function(err, jsonRes, jsonBody) {
    if (jsonRes.statusCode === 201) {
      callback(null, accessToken);
    } else {
      console.log("Error posting to IBM Watson Workspace !");
      console.log("Return code : " + jsonRes.statusCode);
      console.log(jsonBody);
      callback(err, accessToken);
    }
  });
}

//--------------------------------------------------------------------------
//Post a message to a space - Undocumented API, simulating what the Watson Workspace client does.
//Requires a user JWT, not one coming from an OAuth app flow.
function postMessageToSpaceHack(accessToken, spaceId, textMsg, callback) {
  // Build the GraphQL request
  const GraphQLOptions = {
    "url": `${WWS_URL}/graphql`,
    "headers": {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "x-graphql-view": "PUBLIC, SYNCHRONOUS_CREATE_MESSAGE",
      "jwt": "${jwt}"
    },
    "method": "POST",
    "body": ""
  };

  GraphQLOptions.headers.jwt = accessToken;
  //GraphQLOptions.body = 'mutation createMessage {createMessage(input: { conversationId: "593e7ec3e4b0b93c0b5b21e7",  content: "Graphqltest"}){message {id}}}';
  GraphQLOptions.body = '{"operation":"createMessage","query":"mutation createMessage($input: CreateMessageInput!) {createMessage(input: $input) {message {id}}}","variables":"{\\"input\\":{\\"conversationId\\":\\"' + spaceId + '\\",\\"content\\":\\"' + textMsg + '\\"}}"}';
  //console.log(GraphQLOptions.body);
  request(GraphQLOptions, function(err, response, graphqlbody) {
    //console.log(graphqlbody);

    if (!err && response.statusCode === 200) {

      var bodyParsed = JSON.parse(graphqlbody);
      callback(null, accessToken);
    } else if (response.statusCode !== 200) {
      console.log("ERROR: didn't receive 200 OK status, but :" + response.statusCode);
      var error = new Error("");
      callback(error, null, accessToken);
    } else {
      console.log("ERROR: Can't retrieve " + GraphQLOptions.body + " status:" + response.statusCode);
      callback(err, accessToken);
    }
  });
}

//--------------------------------------------------------------------------
//Post a custom message to a space
function postCustomMessageToSpace(accessToken, spaceId, messageData, callback) {
  var jsonClient = requestjs.createClient(WWS_URL);
  var urlToPostMessage = "/v1/spaces/" + spaceId + "/messages";
  jsonClient.headers.jwt = accessToken;

  // Calling IWW API to post message
  jsonClient.post(urlToPostMessage, messageData, function(err, jsonRes, jsonBody) {
    if (jsonRes.statusCode === 201) {
      console.log("Message posted to IBM Watson Workspace successfully!");
      callback(null, accessToken);
    } else {
      console.log("Error posting to IBM Watson Workspace !");
      console.log("Return code : " + jsonRes.statusCode);
      console.log(jsonBody);
      callback(err, accessToken);
    }
  });
}

//--------------------------------------------------------------------------
//Post a message to a space
function postActionFulfillmentMessage(accessToken, afgraphql, callback) {
  // Build the GraphQL request
  const GraphQLOptions = {
    "url": `${WWS_URL}/graphql`,
    "headers": {
      "Content-Type": "application/graphql",
      "x-graphql-view": "PUBLIC, BETA",
      "jwt": "${jwt}"
    },
    "method": "POST",
    "body": ""
  };

  GraphQLOptions.headers.jwt = accessToken;
  GraphQLOptions.body = afgraphql;

  //console.log(GraphQLOptions.body);
  request(GraphQLOptions, function(err, response, graphqlbody) {
    //console.log(graphqlbody);

    if (!err && response.statusCode === 200) {

      var bodyParsed = JSON.parse(graphqlbody);
      callback(null, accessToken);
    } else if (response.statusCode !== 200) {
      console.log("ERROR: didn't receive 200 OK status, but :" + response.statusCode);
      var error = new Error("");
      callback(error, null, accessToken);
    } else {
      console.log("ERROR: Can't retrieve " + GraphQLOptions.body + " status:" + response.statusCode);
      callback(err, accessToken);
    }
  });
}

//--------------------------------------------------------------------------
//Get Authentication Token from an OAuth return code
function getAuthFromOAuthToken(app_id, app_secret, oauth_code, redirect_uri, callback) {
  // Build request options for authentication.
  const authenticationOptions = {
    "method": "POST",
    "url": `${WWS_URL}${AUTHORIZATION_API}`,
    "auth": {
      "user": app_id,
      "pass": app_secret
    },
    "form": {
      "grant_type": "authorization_code",
      "code": oauth_code,
      "redirect_uri": redirect_uri
    }
  };

  console.log("Issuing Authentication request with grant type 'authorization_code'");

  // Get the JWT Token
  request(authenticationOptions, function(err, response, authenticationBody) {
    // If successful authentication, a 200 response code is returned
    if (response.statusCode !== 200) {
      // if our app can't authenticate then it must have been
      // disabled. Just return
      console.log("ERROR: App can't authenticate");
      callback(err, null);
      return;
    }

    var reqbody = JSON.parse(authenticationBody);
    const accessToken = reqbody.access_token;
    const refreshToken = reqbody.refresh_token;
    const userName = reqbody.displayName;
    const userid = reqbody.id;

    callback(null, accessToken, refreshToken, userName, userid);
  });
}

//--------------------------------------------------------------------------
//Get Authentication Token from a Refresh token
function getAuthFromRefreshToken(app_id, app_secret, refreshToken, callback) {
  // Build request options for authentication.
  const authenticationOptions = {
    "method": "POST",
    "url": `${WWS_URL}${AUTHORIZATION_API}`,
    "auth": {
      "user": app_id,
      "pass": app_secret
    },
    "form": {
      "grant_type": "refresh_token",
      "refresh_token": refreshToken
    }
  };

  console.log("Issuing Authentication request with grant type 'refresh_token'");

  // Get the JWT Token
  request(authenticationOptions, function(err, response, authenticationBody) {
    if (err) {
      console.log("ERROR: Authentication request returned an error.");
      console.log(err);
      callback(err);
      return;
    }

    if (response.statusCode !== 200) {
      // App can't authenticate with refreshToken.
      // Just return an error
      var errormsg = "Error authenticating, statuscode=" + response.statusCode.toString();
      console.log("ERROR: App can't authenticate, statuscode =", response.statusCode.toString());
      console.log(response);
      callback(new Error(errormsg));
      return;
    }

    var reqbody = JSON.parse(authenticationBody);
    const accessToken = reqbody.access_token;
    const refreshToken = reqbody.refresh_token;
    const userName = reqbody.displayName;
    const userid = reqbody.id;

    callback(null, accessToken, refreshToken, userName, userid);
  });
}

//--------------------------------------------------------------------------
//Get Authentication Token from a real user Refresh token
//Requires the toscana_refresh_token which can be found in the browser when logged into workspace.
function getAuthFromRefreshTokenHack(refreshToken, callback) {
  // Build request options for authentication.
  const authenticationOptions = {
    "method": "POST",
    "accept": "application/json",
    "url": `${WWS_URL}${AUTHORIZATION_API}`,
    "auth": {
      "user": "toscana-web-client-id",
      "pass": "989b82d0-46ed-457c-ab5f-ccce3ca44dc9"
    },
    "form": {
      "grant_type": "refresh_token",
      "refresh_token": refreshToken
    },
    "x-graphql-view": "PUBLIC"
  };

  console.log("Issuing Authentication request with grant type 'refresh_token'");

  // Get the JWT Token
  request(authenticationOptions, function(err, response, authenticationBody) {
    if (err) {
      console.log("ERROR: Authentication request returned an error.");
      console.log(err);
      callback(err);
      return;
    }

    if (response.statusCode !== 200) {
      // App can't authenticate with refreshToken.
      // Just return an error
      var errormsg = "Error authenticating, statuscode=" + response.statusCode.toString();
      console.log("ERROR: Couldn't get access token, statuscode =", response.statusCode.toString());
      console.log(response.body);
      callback(new Error(errormsg));
      return;
    }

    var resbody = JSON.parse(authenticationBody);
    //console.log(resbody);
    const accessToken = resbody.access_token;
    const refreshToken = resbody.refresh_token;
    const userName = resbody.displayName;
    const userid = resbody.id;

    callback(null, accessToken, refreshToken, userName, userid);
  });
}

//--------------------------------------------------------------------------
//Get Authentication Token from a Refresh token
function getAuthFromRefreshTokenAsync(item, callback) {
  // Build request options for authentication.
  const authenticationOptions = {
    "method": "POST",
    "url": `${WWS_URL}${AUTHORIZATION_API}`,
    "auth": {
      "user": APP_ID,
      "pass": APP_SECRET
    },
    "form": {
      "grant_type": "refresh_token",
      "refresh_token": item.refreshToken
    }
  };

  console.log("Issuing Authentication request with grant type 'refresh_token'");

  // Get the JWT Token
  request(authenticationOptions, function(err, response, authenticationBody) {
    if (err) {
      console.log("ERROR: Authentication request returned an error.");
      console.log(err);
      callback(err);
      return;
    }

    if (response.statusCode !== 200) {
      // App can't authenticate with refreshToken.
      // Just return an error
      var errormsg = "Error authenticating, statuscode=" + response.statusCode.toString();
      console.log("ERROR: App can't authenticate, statuscode =", response.statusCode.toString());
      //console.log(response);
      callback(new Error(errormsg));
      return;
    }

    var reqbody = JSON.parse(authenticationBody);
    const accessToken = reqbody.access_token;
    const refreshToken = reqbody.refresh_token;
    const userName = reqbody.displayName;
    const userid = reqbody.id;

    callback(null, accessToken, refreshToken, userName, userid);
  });
}

//--------------------------------------------------------------------------
//Get an authentication token from AppId and secret
function getAuthFromAppIdSecret(app_id, app_secret, callback) {
  // Build request options for authentication.
  const authenticationOptions = {
    "method": "POST",
    "url": `${WWS_URL}${AUTHORIZATION_API}`,
    "auth": {
      "user": app_id,
      "pass": app_secret
    },
    "form": {
      "grant_type": "client_credentials"
    }
  };

  // Get the JWT Token
  request(authenticationOptions, function(err, response, authenticationBody) {
    if (err) {
      console.log("ERROR: Authentication request returned an error.");
      console.log(err);
      callback(err);
      return;
    }

    // If successful authentication, a 200 response code is returned
    if (response.statusCode !== 200) {
      // if our app can't authenticate then it must have been
      // disabled.
      var errormsg = "Error authenticating, statuscode=" + response.statusCode.toString();
      console.log("ERROR: App can't authenticate, statuscode =", response.statusCode.toString());
      callback(new Error(errormsg));
      return;
    }

    const accessToken = JSON.parse(authenticationBody).access_token;
    callback(null, accessToken);
  });
}
