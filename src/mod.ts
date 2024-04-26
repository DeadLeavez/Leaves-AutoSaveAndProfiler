import { DependencyContainer } from "tsyringe";
import { ILogger } from "@spt-aki/models/spt/utils/ILogger";

import { VFS } from "@spt-aki/utils/VFS";
import { jsonc } from "jsonc";
import * as path from "path";
import { LogTextColor } from "@spt-aki/models/spt/logging/LogTextColor";

//item creation
import { ConfigTypes } from "@spt-aki/models/enums/ConfigTypes";
import { SaveServer } from "@spt-aki/servers/SaveServer";
import { ICoreConfig } from "@spt-aki/models/spt/config/ICoreConfig";
import { OnUpdateModService } from "@spt-aki/services/mod/onUpdate/OnUpdateModService";

function zipDirectory ( filepath: string, directoryToZip: string )
{
    let filesystem = require( "fs" );
    let archiver = require( "archiver" ); //Our dependency

    // get content to zip
    const output = filesystem.createWriteStream( filepath );

    // create archiver
    const archive = archiver( "zip", {
        zlib: { level: 9 },
    } );

    // tell the archiver what to zip
    archive.pipe( output );

    archive.directory( directoryToZip );

    // actually zip the thing
    archive.finalize();
}

class AutoSaveAndProfiler
{
    private logger: ILogger;

    //Config
    private config: any;
    private vfs: VFS;

    private saveServer: SaveServer;

    private profileFolder = "user/profiles/";
    private backupFolder = `user/profiles_backups/`;

    public preAkiLoad ( container: DependencyContainer ): void
    {
        this.saveServer = container.resolve<SaveServer>( "SaveServer" );
        this.logger = container.resolve<ILogger>( "WinstonLogger" );

        this.vfs = container.resolve<VFS>( "VFS" );
        const configFile = path.resolve( __dirname, "../config/config.jsonc" );
        this.config = jsonc.parse( this.vfs.readFile( configFile ) );

        this.printColor( "[ASAP] Starting:" );

        if ( this.config.enableBackup )
        {
            // check if backup folder exists
            if ( !this.vfs.exists( this.backupFolder ) )
            {
                this.printColor( "[ASAP] Missing backup folder. Creating.", LogTextColor.CYAN );
                this.vfs.createDir( this.backupFolder );
            }
        }

        if ( this.config.enableNameChange )
        {
            container.afterResolution( "SaveServer", ( _t, result: SaveServer ) => 
            {
                // replace code with ours
                result.saveProfile = ( sessionID: string ) => 
                {
                    const filePath = `${ this.saveServer.profileFilepath }${ this.saveServer.getProfile( sessionID ).info.username }-${ sessionID }.json`;

                    // Run pre-save callbacks before we save into json
                    for ( const callback in this.saveServer.onBeforeSaveCallbacks )
                    {
                        const previous = this.saveServer.profiles[ sessionID ];
                        try
                        {
                            this.saveServer.profiles[ sessionID ] = this.saveServer.onBeforeSaveCallbacks[ callback ]( this.saveServer.profiles[ sessionID ] );
                        }
                        catch ( error )
                        {
                            this.logger.error( this.saveServer.localisationService.getText( "profile_save_callback_error", { callback, error } ) );
                            this.saveServer.profiles[ sessionID ] = previous;
                        }
                    }

                    const start = performance.now();
                    const jsonProfile = this.saveServer.jsonUtil.serialize(
                        this.saveServer.profiles[ sessionID ],
                        !this.saveServer.configServer.getConfig<ICoreConfig>( ConfigTypes.CORE ).features.compressProfile,
                    );
                    const fmd5 = this.saveServer.hashUtil.generateMd5ForData( jsonProfile );
                    if ( typeof ( this.saveServer.saveMd5[ sessionID ] ) !== "string" || this.saveServer.saveMd5[ sessionID ] !== fmd5 )
                    {
                        this.saveServer.saveMd5[ sessionID ] = String( fmd5 );
                        // save profile to disk
                        this.vfs.writeFile( filePath, jsonProfile );
                    }

                    return Number( performance.now() - start );
                }

                // The modifier Always makes sure this replacement method is ALWAYS replaced
            }, { frequency: "Always" } );
            container.afterResolution( "SaveServer", ( _t, result: SaveServer ) => 
            {
                result.loadProfile = ( filenameWOJSON: string ) => 
                {
                    const filename = `${ filenameWOJSON }.json`;
                    const filePath = `${ this.saveServer.profileFilepath }${ filename }`;
                    let sessionID = "";
                    if ( this.vfs.exists( filePath ) )
                    {
                        // File found, store in profiles[]
                        const start = performance.now();
                        let profileData: any = this.saveServer.jsonUtil.deserialize( this.vfs.readFile( filePath ), filename );
                        sessionID = profileData.info.id;
                        this.saveServer.profiles[ sessionID ] = profileData;
                        this.logger.debug( `Profile: ${ sessionID } took: ${ performance.now() - start }ms to load.`, true );
                    }
                    else
                    {
                        //fuck whoever wrote this garbage.
                        sessionID = filenameWOJSON;
                    }
                    // Run callbacks
                    for ( const callback of this.saveServer.saveLoadRouters )
                    {
                        this.saveServer.profiles[ sessionID ] = callback.handleLoad( this.saveServer.getProfile( sessionID ) );
                    }
                }
            }, { frequency: "Always" } );
        }

        if ( this.config.enableBackup )
        {
            const onUpdateModService = container.resolve<OnUpdateModService>( "OnUpdateModService" );

            onUpdateModService.registerOnUpdate(
                "leaves-backup-mod-asap",
                ( timeSinceLastRun: number ) => this.backupSaves( timeSinceLastRun ),
                () => "leaves-backup-mod-asap" // new route name
            );
        }
    }

    backupSaves ( timeSinceLastRun: number ): boolean
    {
        if ( timeSinceLastRun > this.config.timeBetweenSavesSeconds )
        {
            this.printColor( "[ASAP]Backing up saves", LogTextColor.BLUE );
            //Backup saves
            const time: Date = new Date();
            const timestamp: string = time.toLocaleDateString().replaceAll( /[\\/:*?\"<>|]/g, "_" ) + "-" + time.toLocaleTimeString().replaceAll( /[\\/:*?\"<>|]/g, "_" );
            const backupName = this.backupFolder + `${ timestamp }.zip`;
            zipDirectory( backupName, this.profileFolder );

            return true;
        }
        return false;
    }


    private printColor ( message: string, color: LogTextColor = LogTextColor.GREEN )
    {
        this.logger.logWithColor( message, color );
    }
}

module.exports = { mod: new AutoSaveAndProfiler() }