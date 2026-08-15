import { CompositeDisposable } from '@/util/disposable/CompositeDisposable';
import { EventType } from '@/game/event/EventType';
import { SoundKey } from '@/engine/sound/SoundKey';
import { ChannelType } from '@/engine/sound/ChannelType';
import { Coords } from '@/game/Coords';
import { PowerupType } from '@/game/type/PowerupType';
import { SuperWeaponType } from '@/game/type/SuperWeaponType';
import { RadarEventType } from '@/game/rules/general/RadarRules';
import { OrderType } from '@/game/order/OrderType';
import { OrderFeedbackType } from '@/game/order/OrderFeedbackType';
import { QueueStatus } from '@/game/player/production/ProductionQueue';
import { ObjectType } from '@/engine/type/ObjectType';
import { StanceType } from '@/game/gameobject/infantry/StanceType';
import { WeaponType } from '@/game/WeaponType';
import { DeathType } from '@/game/gameobject/common/DeathType';
import { ZoneType } from '@/game/gameobject/unit/ZoneType';
import { BuildStatus } from '@/game/gameobject/Building';
import { AllianceEventType } from '@/game/event/AllianceChangeEvent';
import { VeteranLevel } from '@/game/gameobject/unit/VeteranLevel';
import { HealthLevel } from '@/game/gameobject/unit/HealthLevel';
import { FactoryType } from '@/game/rules/TechnoRules';
import { QueryType } from '@/gui/screen/game/worldInteraction/UnitSelectionHandler';
import { aiUiNames } from '@/game/gameopts/constants';
import { StalemateDetectTrait } from '@/game/trait/StalemateDetectTrait';
import { equals } from '@/util/array';

const detectedSuperWeaponEvaByType = new Map([
    [SuperWeaponType.MultiMissile, 'EVA_NuclearSiloDetected'],
    [SuperWeaponType.IronCurtain, 'EVA_IronCurtainDetected'],
    [SuperWeaponType.ChronoSphere, 'EVA_ChronosphereDetected'],
    [SuperWeaponType.LightningStorm, 'EVA_WeatherDeviceReady'],
]);

const superWeaponReadyEvaByType = new Map([
    [SuperWeaponType.MultiMissile, 'EVA_NuclearMissileReady'],
    [SuperWeaponType.IronCurtain, 'EVA_IronCurtainReady'],
    [SuperWeaponType.ChronoSphere, 'EVA_ChronosphereReady'],
    [SuperWeaponType.LightningStorm, 'EVA_LightningStormReady'],
    [SuperWeaponType.ParaDrop, 'EVA_ReinforcementsReady'],
    [SuperWeaponType.AmerParaDrop, 'EVA_ReinforcementsReady'],
]);

const superWeaponActivateEvaByType = new Map([
    [SuperWeaponType.MultiMissile, 'EVA_NuclearMissileLaunched'],
    [SuperWeaponType.IronCurtain, 'EVA_IronCurtainActivated'],
    [SuperWeaponType.ChronoSphere, 'EVA_ChronosphereActivated'],
    [SuperWeaponType.LightningStorm, 'EVA_LightningStormCreated'],
]);

const superWeaponActivateSoundByType = new Map([
    [SuperWeaponType.MultiMissile, SoundKey.DigSound],
]);

const superWeaponActivateMessageByType = new Map([
    [SuperWeaponType.LightningStorm, 'TXT_LIGHTNING_STORM_APPROACHING'],
]);

const crateSoundByType = new Map([
    [PowerupType.Veteran, SoundKey.CratePromoteSound],
    [PowerupType.Money, SoundKey.CrateMoneySound],
    [PowerupType.Reveal, SoundKey.CrateRevealSound],
    [PowerupType.Firepower, SoundKey.CrateFireSound],
    [PowerupType.Armor, SoundKey.CrateArmourSound],
    [PowerupType.Speed, SoundKey.CrateSpeedSound],
    [PowerupType.Unit, SoundKey.CrateUnitSound],
]);

const crateEvaByType = new Map([
    [PowerupType.Armor, 'EVA_UnitArmorUpgraded'],
    [PowerupType.Firepower, 'EVA_UnitFirePowerUpgraded'],
    [PowerupType.Speed, 'EVA_UnitSpeedUpgraded'],
]);

export class SoundHandler {
    private lastAvailableObjectNames: string[] = [];
    private lastQueueStatuses = new Map();
    private triggerSoundHandles = new Map();
    private disposables = new CompositeDisposable();
    private lastFeedbackTime?: number;
    constructor(private game: any, private worldSound: any, private eva: any, private sound: any, private gameEvents: any, private messageList: any, private strings: any, private player: any) { }
    init(): void {
        this.disposables.add(this.gameEvents.subscribe((event: any) => this.handleGameEvent(event)));
    }
    dispose(): void {
        this.disposables.dispose();
    }
    handleAvailableObjectsUpdate(availableObjects: any[]): void {
        const names = availableObjects.map((object: any) => object.name);
        if (!equals(this.lastAvailableObjectNames, names) && names.length > this.lastAvailableObjectNames.length) {
            this.lastAvailableObjectNames = names;
            this.eva.play('EVA_NewConstructionOptions');
        }
    }
    handleProductionQueueUpdate(queue: any): void {
        const lastStatus = this.lastQueueStatuses.get(queue.type);
        if (lastStatus === undefined || queue.status !== lastStatus) {
            this.lastQueueStatuses.set(queue.type, queue.status);
            switch (queue.status) {
                case QueueStatus.Ready:
                    if (queue.getFirst().rules.type === ObjectType.Building) {
                        this.eva.play('EVA_ConstructionComplete');
                    }
                    else {
                        this.eva.play('EVA_UnitReady');
                    }
                    break;
                case QueueStatus.Active:
                    if (queue.getFirst().rules.type === ObjectType.Building) {
                        this.eva.play('EVA_Building');
                    }
                    else if (lastStatus === QueueStatus.Idle) {
                        this.eva.play('EVA_Training');
                    }
                    break;
                case QueueStatus.OnHold:
                    this.eva.play('EVA_OnHold');
                    break;
                default:
                    break;
            }
        }
    }
    private handleGameEvent(event: any): void {
        switch (event.type) {
            case EventType.Cheer:
                this.sound.play(SoundKey.CheerSound, ChannelType.Effect);
                break;
            case EventType.UnitDeployUndeploy:
                const isUndeploy = event.deployType === 'undeploy';
                const unit = event.unit;
                const deploySound = isUndeploy ? unit.rules.undeploySound : unit.rules.deploySound;
                if (deploySound) {
                    this.worldSound.playEffect(deploySound, unit, unit.owner);
                }
                break;
            case EventType.ObjectTeleport:
                if (event.isChronoshift) {
                    if (event.target.rules.chronoInSound) {
                        this.worldSound.playEffect(event.target.rules.chronoInSound, event.target, event.target.owner);
                    }
                    if (event.target.rules.chronoOutSound) {
                        const position = Coords.tile3dToWorld(event.prevTile.rx + 0.5, event.prevTile.ry + 0.5, event.prevTile.z);
                        this.worldSound.playEffect(event.target.rules.chronoOutSound, position, event.target.owner);
                    }
                }
                break;
            case EventType.WeaponFire:
                this.handleWeaponFireSound(event);
                break;
            case EventType.InflictDamage:
                this.handleDamageSound(event);
                break;
            case EventType.RadarEvent:
                this.handleRadarEventSound(event);
                break;
            case EventType.SuperWeaponReady:
                this.handleSuperWeaponReadySound(event);
                break;
            case EventType.SuperWeaponActivate:
                this.handleSuperWeaponActivateSound(event);
                break;
            case EventType.LightningStormManifest:
                this.handleLightningStormManifestSound(event);
                break;
            case EventType.WarheadDetonate:
                this.handleWarheadDetonateSound(event);
                break;
            case EventType.ObjectLiftOff:
                if (event.gameObject.rules.auxSound1) {
                    this.worldSound.playEffect(event.gameObject.rules.auxSound1, event.gameObject, event.gameObject.owner);
                }
                break;
            case EventType.ObjectLand:
                if (event.gameObject.rules.auxSound2) {
                    this.worldSound.playEffect(event.gameObject.rules.auxSound2, event.gameObject, event.gameObject.owner);
                }
                break;
            case EventType.ObjectCrashing:
                const crashingObject = event.gameObject;
                if (crashingObject.rules.crashingSound) {
                    this.worldSound.playEffect(crashingObject.rules.crashingSound, crashingObject.position.worldPosition, crashingObject.owner);
                }
                if (crashingObject.owner === this.player && crashingObject.rules.voiceCrashing) {
                    this.worldSound.playEffect(crashingObject.rules.voiceCrashing, crashingObject.position.worldPosition, crashingObject.owner);
                }
                break;
            case EventType.ObjectDestroy:
                this.handleObjectDestroySound(event);
                break;
            case EventType.ObjectSpawn:
                this.handleObjectSpawnSound(event);
                break;
            case EventType.ObjectUnspawn:
                const unspawned = event.gameObject;
                if (unspawned.isBuilding() && unspawned.rules.spySat) {
                    this.worldSound.playEffect(SoundKey.SpySatDeactivationSound, unspawned, unspawned.owner);
                }
                break;
            case EventType.ObjectMorph:
                if (event.to?.isBuilding()) {
                    this.worldSound.playEffect(SoundKey.BuildingDrop, event.to, event.to.owner);
                }
                break;
            case EventType.ShipSubmergeChange:
                this.worldSound.playEffect(SoundKey.CloakSound, event.target, event.target.owner);
                break;
            case EventType.BridgeRepair:
                if (event.source === this.player) {
                    this.eva.play('EVA_BridgeRepaired');
                }
                break;
            case EventType.BuildStatusChange:
                if (event.status === BuildStatus.BuildDown) {
                    this.worldSound.playEffect(SoundKey.SellSound, event.target.position.worldPosition, event.target.owner);
                    if (event.target.poweredTrait && event.target.rules.notWorkingSound) {
                        this.worldSound.playEffect(event.target.rules.notWorkingSound, event.target, event.target.owner);
                    }
                }
                break;
            case EventType.BuildingPlace:
                this.handleBuildingPlaceSound(event);
                break;
            case EventType.BuildingFailedPlace:
                if (this.player === event.player) {
                    this.eva.play('EVA_CannotDeployHere');
                }
                break;
            case EventType.ObjectSell:
                const sold = event.target;
                if (sold.rules.wall) {
                    this.worldSound.playEffect(SoundKey.SellSound, sold.position.worldPosition, sold.owner);
                }
                if (this.player === sold.owner) {
                    this.eva.play(sold.isBuilding() ? 'EVA_StructureSold' : 'EVA_UnitSold', true);
                }
                break;
            case EventType.BuildingRepairFull:
                if (event.source === this.player) {
                    this.worldSound.playEffect(SoundKey.BuildingRepairedSound, event.target, event.source);
                }
                break;
            case EventType.BuildingCapture:
                if (event.target.owner === this.player) {
                    this.eva.play(event.target.rules.needsEngineer ? 'EVA_TechBuildingCaptured' : 'EVA_BuildingCaptured');
                }
                break;
            case EventType.BuildingInfiltration:
                this.handleBuildingInfiltrationSound(event);
                break;
            case EventType.BuildingGarrison:
                this.worldSound.playEffect(SoundKey.BuildingGarrisonedSound, event.target, event.target.owner);
                if (event.target.owner === this.player) {
                    this.eva.play('EVA_StructureGarrisoned');
                }
                break;
            case EventType.BuildingEvacuate:
                if (event.player === this.player) {
                    this.eva.play('EVA_StructureAbandoned');
                }
                break;
            case EventType.BuildingRepairStart:
            case EventType.UnitRepairStart:
                if (event.target.owner === this.player) {
                    this.eva.play('EVA_Repairing');
                }
                break;
            case EventType.UnitRepairFinish:
                if (event.target.owner === this.player) {
                    this.eva.play('EVA_UnitRepaired');
                    if (event.from.rules.hospital) {
                        this.worldSound.playEffect(this.game.rules.crateRules.healCrateSound, event.target, event.target.owner);
                    }
                }
                break;
            case EventType.UnitRecycle:
                if (event.target.rules.dieSound) {
                    this.worldSound.playEffect(event.target.rules.dieSound, event.target.position.worldPosition, event.target.owner);
                }
                break;
            case EventType.PlayerDefeated:
                this.handlePlayerDefeatedSound(event);
                break;
            case EventType.PlayerResigned:
                this.eva.play('EVA_PlayerResigned');
                {
                    const target = event.target;
                    const name = target.isAi
                        ? this.strings.get(aiUiNames.get(target.aiDifficulty))
                        : target.name;
                    this.messageList.addSystemMessage(target.isObserver
                        ? this.strings.get('TXT_PLAYER_DEFEATED', name)
                        : this.strings.get('TXT_LEFT_GAME', name), target);
                    if (event.assetsRedistributed) {
                        this.messageList.addSystemMessage(this.strings.get('TS:PlayerAssetsSplit', target.name), target);
                    }
                }
                break;
            case EventType.PlayerDropped:
                {
                    const target = event.target;
                    this.messageList.addSystemMessage(this.strings.get('TXT_CONNECTION_LOST', target.name), 'grey');
                    if (event.assetsRedistributed) {
                        this.messageList.addSystemMessage(this.strings.get('TS:PlayerAssetsSplit', target.name), target);
                    }
                }
                break;
            case EventType.DeployNotAllowed:
                if (event.target.owner === this.player) {
                    this.eva.play('EVA_CannotDeployHere');
                }
                break;
            case EventType.PowerLow:
                if (event.target === this.player) {
                    this.eva.play('EVA_LowPower');
                    this.messageList.addSystemMessage(this.strings.get('TXT_LOW_POWER'), this.player);
                }
                break;
            case EventType.RadarOnOff:
                if (event.target === this.player) {
                    this.sound.play(event.radarEnabled ? SoundKey.RadarOn : SoundKey.RadarOff, ChannelType.Effect);
                }
                break;
            case EventType.InsufficientFunds:
                if (event.target === this.player) {
                    this.eva.play('EVA_InsufficientFunds');
                }
                break;
            case EventType.RallyPointChange:
                if (event.target.owner === this.player) {
                    this.eva.play('EVA_NewRallyPointEstablished');
                }
                break;
            case EventType.PrimaryFactoryChange:
                if (event.target.owner === this.player) {
                    this.eva.play('EVA_PrimaryBuildingSelected');
                }
                break;
            case EventType.AllianceChange:
                this.handleAllianceChangeSound(event);
                break;
            case EventType.UnitPromote:
                this.handleUnitPromoteSound(event);
                break;
            case EventType.EnterTransport:
                if (event.target.rules.enterTransportSound) {
                    this.worldSound.playEffect(event.target.rules.enterTransportSound, event.target, event.target.owner);
                }
                break;
            case EventType.LeaveTransport:
                if (event.target.rules.leaveTransportSound) {
                    this.worldSound.playEffect(event.target.rules.leaveTransportSound, event.target, event.target.owner);
                }
                break;
            case EventType.CratePickup:
                this.handleCratePickupSound(event);
                break;
            case EventType.StalemateDetect:
                {
                    const minutes = Math.floor(StalemateDetectTrait.graceMinutes);
                    this.messageList.addSystemMessage(this.strings.get('TS:StalemateWarning', minutes), 'white', 20);
                    this.eva.play(minutes > 1 ? `EVA_${minutes}MinutesRemaining` : 'EVA_1MinuteRemaining');
                }
                break;
            case EventType.TriggerSoundFx:
                if (event.tile) {
                    const handle = this.worldSound.playEffect(event.soundId, Coords.tile3dToWorld(event.tile.rx, event.tile.ry, event.tile.z));
                    if (handle) {
                        const handles = this.triggerSoundHandles.get(event.tile) ?? [];
                        handles.push(handle);
                        this.triggerSoundHandles.set(event.tile, handles);
                    }
                }
                else {
                    this.sound.play(event.soundId, ChannelType.Effect);
                }
                break;
            case EventType.TriggerStopSoundFx:
                {
                    const handles = this.triggerSoundHandles.get(event.tile);
                    if (handles) {
                        for (const handle of handles) {
                            if (handle.isPlaying()) {
                                handle.stop();
                            }
                        }
                        this.triggerSoundHandles.delete(event.tile);
                    }
                }
                break;
            case EventType.TriggerEva:
                this.eva.play(event.soundId);
                break;
            case EventType.TriggerText:
                this.messageList.addSystemMessage(this.strings.get(event.label), this.player ?? 'grey');
                break;
            default:
                break;
        }
    }
    private handleWeaponFireSound(event: any): void {
        if (event.weapon.type === WeaponType.DeathWeapon && event.gameObject.isCrashing) {
            return;
        }
        const weapon = event.weapon;
        const report = weapon.rules.report;
        if (report?.length) {
            const volume = weapon.warhead.rules.electricAssault ? 0.25 : 1;
            const soundIndex = Math.floor(Math.random() * report.length);
            this.worldSound.playEffect(report[soundIndex], event.gameObject.position.worldPosition, event.gameObject.owner, volume);
        }
    }
    private handleDamageSound(event: any): void {
        const target = event.target;
        if (target.healthTrait.health && target.isTechno()) {
            if (target.isBuilding()) {
                if (target.wallTrait) {
                    return;
                }
                const damagePercent = (event.damageHitPoints / target.healthTrait.maxHitPoints) * 100;
                const rules = this.game.rules.audioVisual;
                const redThreshold = 100 * rules.conditionRed;
                const yellowThreshold = 100 * rules.conditionYellow;
                const health = target.healthTrait.health;
                if ((health <= yellowThreshold && yellowThreshold < health + damagePercent) ||
                    (health <= redThreshold && redThreshold < health + damagePercent)) {
                    this.worldSound.playEffect(SoundKey.BuildingDamageSound, target, target.owner);
                }
            }
            else if (target.owner === this.player &&
                target.rules.voiceFeedback &&
                Math.random() > 0.9) {
                this.worldSound.playEffect(target.rules.voiceFeedback, target, target.owner);
            }
        }
    }
    private handleRadarEventSound(event: any): void {
        if (event.radarEventType === RadarEventType.BaseUnderAttack || event.radarEventType === 'BaseUnderAttack') {
            if (event.target === this.player) {
                this.eva.play('EVA_OurBaseIsUnderAttack');
                this.sound.play(SoundKey.BaseUnderAttackSound, ChannelType.Effect);
            }
            else if (this.player && this.game.alliances.areAllied(this.player, event.target)) {
                this.eva.play('EVA_OurAllyIsUnderAttack');
                this.sound.play(SoundKey.BaseUnderAttackSound, ChannelType.Effect);
            }
        }
        else if (event.radarEventType === RadarEventType.HarvesterUnderAttack || event.radarEventType === 'HarvesterUnderAttack') {
            if (event.target === this.player) {
                this.eva.play('EVA_OreMinerUnderAttack');
            }
        }
        else if ((event.radarEventType === RadarEventType.EnemyObjectSensed || event.radarEventType === 'EnemyObjectSensed') && event.target === this.player) {
            const building = this.game.map.getGroundObjectsOnTile(event.tile).find((object: any) => object.isBuilding() && object.superWeaponTrait);
            const superWeaponType = building?.superWeaponTrait?.getSuperWeapon(building)?.rules.type;
            const eva = detectedSuperWeaponEvaByType.get(superWeaponType);
            if (eva) {
                this.eva.play(eva);
            }
        }
    }
    private handleSuperWeaponReadySound(event: any): void {
        if (event.target.owner === this.player) {
            const eva = event.target.rules?.type !== undefined
                ? superWeaponReadyEvaByType.get(event.target.rules.type)
                : undefined;
            if (eva) {
                this.eva.play(eva);
            }
        }
    }
    private handleSuperWeaponActivateSound(event: any): void {
        if (!event.noSfxWarning) {
            const eva = superWeaponActivateEvaByType.get(event.target);
            if (eva) {
                this.eva.play(eva, true);
            }
            const sound = superWeaponActivateSoundByType.get(event.target);
            if (sound) {
                this.worldSound.playEffect(sound, Coords.tile3dToWorld(event.atTile.rx, event.atTile.ry, event.atTile.z), event.owner);
            }
        }
        const message = superWeaponActivateMessageByType.get(event.target);
        if (message) {
            this.messageList.addSystemMessage(this.strings.get(message), this.player ?? 'grey');
        }
    }
    private handleLightningStormManifestSound(event: any): void {
        this.messageList.addSystemMessage(this.strings.get('TXT_LIGHTNING_STORM'), this.player ?? 'grey');
        this.worldSound.playEffect(SoundKey.StormSound, Coords.tile3dToWorld(event.target.rx, event.target.ry, event.target.z));
    }
    private handleWarheadDetonateSound(event: any): void {
        if (event.isLightningStrike) {
            this.worldSound.playEffect(SoundKey.LightningSounds, event.position);
        }
    }
    private handleObjectDestroySound(event: any): void {
        const target = event.target;
        let sound: SoundKey | string | undefined;
        if (target.isUnit() && !target.isInfantry() && target.isCrashing) {
            sound = target.zone === ZoneType.Water
                ? this.game.rules.audioVisual.impactWaterSound
                : target.rules.impactLandSound ?? this.game.rules.audioVisual.impactLandSound;
        }
        else if (target.deathType === DeathType.Temporal || target.deathType === DeathType.None) {
            sound = undefined;
        }
        else if (target.deathType === DeathType.Crush) {
            sound = (target.rules as any).crushSound;
        }
        else if (target.isVehicle() && target.zone === ZoneType.Water && target.isSinker) {
            sound = SoundKey.SinkingSound;
        }
        else if (target.isTechno()) {
            sound = target.rules.dieSound;
            if (!sound && target.isBuilding()) {
                sound = SoundKey.BuildingDieSound;
            }
        }
        else if (target.isProjectile()) {
            if (target.fromWeapon.warhead.rules.ivanBomb) {
                sound = SoundKey.BombAttachSound;
            }
            else if (target.fromWeapon.warhead.rules.mindControl) {
                sound = SoundKey.YuriMindControlSound;
            }
        }
        if (sound) {
            let owner: any;
            if (target.isTechno()) {
                owner = target.owner;
            }
            else if (target.isProjectile()) {
                owner = target.fromPlayer;
            }
            this.worldSound.playEffect(sound, target.position.worldPosition, owner);
        }
        if (target.isUnit() && !target.rules.spawned && target.owner === this.player) {
            this.eva.play('EVA_UnitLost');
        }
    }
    private handleObjectSpawnSound(event: any): void {
        const gameObject = event.gameObject;
        if (gameObject.isTechno() && gameObject.rules.createSound) {
            this.worldSound.playEffect(gameObject.rules.createSound, gameObject, gameObject.owner);
        }
        if (gameObject.isInfantry() && gameObject.stance === StanceType.Paradrop) {
            this.worldSound.playEffect(SoundKey.ChuteSound, gameObject, gameObject.owner);
        }
    }
    private handleBuildingPlaceSound(event: any): void {
        const building = event.target;
        this.worldSound.playEffect(SoundKey.BuildingSlam, building, building.owner);
        if (building.rules.spySat) {
            this.worldSound.playEffect(SoundKey.SpySatActivationSound, building, building.owner);
        }
    }
    private handleBuildingInfiltrationSound(event: any): void {
        const source = event.source;
        const target = event.target;
        if (!this.player ||
            this.player.isObserver ||
            target.owner === this.player ||
            source.owner === this.player) {
            const isOwner = target.owner === this.player;
            if (!target.rules.radar || isOwner) {
                this.eva.play('EVA_BuildingInfiltrated');
            }
            let eva: string | undefined;
            if (target.rules.radar) {
                eva = isOwner ? 'EVA_RadarSabotaged' : 'EVA_BuildingInfRadarSabotaged';
            }
            if (target.rules.power > 0) {
                eva = isOwner ? 'EVA_PowerSabotaged' : 'EVA_EnemyBasePoweredDown';
            }
            if (target.rules.storage) {
                eva = isOwner ? 'EVA_CashStolen' : 'EVA_BuildingInfCashStolen';
            }
            if (this.game.rules.ai.buildTech.includes(target.name) ||
                [FactoryType.InfantryType, FactoryType.UnitType].includes(target.factoryTrait?.type)) {
                eva = isOwner ? 'EVA_TechnologyStolen' : 'EVA_NewTechnologyAcquired';
            }
            if (eva) {
                this.eva.play(eva);
            }
        }
    }
    private handlePlayerDefeatedSound(event: any): void {
        const player = event.target;
        if (player === this.player && !this.player.isObserver) {
            return;
        }
        if (!player.resigned) {
            const playerName = player.isAi
                ? this.strings.get(aiUiNames.get(player.aiDifficulty))
                : player.name;
            this.eva.play(player !== this.player ? 'EVA_PlayerDefeated' : 'EVA_YouHaveLost');
            this.messageList.addSystemMessage(this.strings.get('TXT_PLAYER_DEFEATED', playerName), player);
        }
    }
    private handleUnitPromoteSound(event: any): void {
        if (event.target.owner === this.player) {
            const isElite = event.target.veteranLevel === 'Elite';
            this.sound.play(isElite ? SoundKey.UpgradeEliteSound : SoundKey.UpgradeVeteranSound, ChannelType.Effect);
            this.eva.play('EVA_UnitPromoted', true);
        }
    }
    private handleAllianceChangeSound(event: any): void {
        const alliance = event.alliance;
        const changeType = event.changeType;
        const from = event.from;
        if (changeType === AllianceEventType.Formed) {
            if (!this.player ||
                this.player.isObserver ||
                alliance.players.has(this.player) ||
                (this.game.alliances.areAllied(this.player, alliance.players.first) &&
                    this.game.alliances.areAllied(this.player, alliance.players.second))) {
                this.eva.play('EVA_AllianceFormed');
            }
            else {
                this.eva.play('EVA_EnemyAllianceFormed');
            }
            this.messageList.addSystemMessage(this.strings.get('TXT_HAS_ALLIED', alliance.players.second.name, alliance.players.first.name), 'white');
        }
        else if (changeType === AllianceEventType.Requested) {
            if (this.player === alliance.players.first) {
                this.eva.play('EVA_RequestingAlliance');
            }
            else if (this.player === alliance.players.second) {
                this.eva.play('EVA_AllianceRequested');
            }
            this.messageList.addSystemMessage(this.strings.get('TXT_HAS_ALLIED', alliance.players.first.name, alliance.players.second.name), 'lightgrey');
        }
        else if (changeType === AllianceEventType.Broken) {
            this.eva.play('EVA_AllianceBroken');
            const other = from === alliance.players.first ? alliance.players.second : alliance.players.first;
            this.messageList.addSystemMessage(this.strings.get('TXT_AT_WAR', from.name, other.name), 'white');
        }
    }
    private handleCratePickupSound(event: any): void {
        const crateType = event.target?.type;
        let sound = crateSoundByType.get(crateType);
        if (!sound && crateType === PowerupType.HealBase) {
            sound = this.game.rules.crateRules.healCrateSound;
        }
        const eva = crateEvaByType.get(crateType);
        const isHostilePickup = this.player &&
            !this.player.isObserver &&
            event.player !== this.player &&
            !this.game.alliances.areAllied(event.player, this.player);
        if (isHostilePickup) {
            return;
        }
        if (sound) {
            const position = Coords.tile3dToWorld(event.tile.rx, event.tile.ry, event.tile.z);
            this.worldSound.playEffect(sound, position, event.player);
        }
        if (eva) {
            this.eva.play(eva);
        }
    }
    handleOrderPushed(unit: any, orderType: any, feedbackType: any): void {
        const now = Date.now();
        if (!this.lastFeedbackTime || now - this.lastFeedbackTime >= 250) {
            let sound: SoundKey | string | undefined;
            if (orderType === OrderType.Stop) {
                sound = SoundKey.StopSound;
            }
            else if (orderType === OrderType.Guard) {
                sound = SoundKey.GuardSound;
            }
            else if (orderType === OrderType.Scatter) {
                sound = SoundKey.ScatterSound;
            }
            else {
                switch (feedbackType) {
                    case OrderFeedbackType.Attack:
                        sound = unit.rules.voiceAttack;
                        break;
                    case OrderFeedbackType.Move:
                        sound = unit.rules.voiceMove;
                        break;
                    case OrderFeedbackType.Capture:
                        sound = unit.rules.voiceCapture || unit.rules.voiceSpecialAttack;
                        break;
                    case OrderFeedbackType.SpecialAttack:
                        sound = unit.rules.voiceSpecialAttack;
                        break;
                    case OrderFeedbackType.Enter:
                        sound = unit.rules.voiceEnter || unit.rules.voiceMove;
                        break;
                    default:
                        break;
                }
            }
            if (sound) {
                this.sound.play(sound, ChannelType.Effect);
                this.lastFeedbackTime = now;
            }
        }
    }
    handleSelectionChangeEvent(event: any): void {
        const { selection, queryType, veteranLevel, healthLevel } = event;
        if (!selection.length || selection[0].owner === this.player) {
            const now = Date.now();
            const canPlay = !this.lastFeedbackTime || now - this.lastFeedbackTime >= 250;
            if (canPlay) {
                this.lastFeedbackTime = now;
            }
            if (queryType) {
                if (canPlay) {
                    const voices = selection
                        .map((unit: any) => unit.rules.voiceSelect)
                        .filter((voice: any) => voice != null);
                    const counts = new Map<string, number>();
                    voices.forEach((voice: string) => {
                        counts.set(voice, (counts.get(voice) ?? 0) + 1);
                    });
                    counts.forEach((count, voice) => {
                        const spec = this.sound.getSoundSpec(voice);
                        if (spec) {
                            const plays = Math.min(spec.limit, count);
                            for (let i = 0; i < plays; i++) {
                                this.sound.play(voice, ChannelType.Effect);
                            }
                        }
                    });
                }
                if (selection.length || [QueryType.Veteran, QueryType.Health].includes(queryType)) {
                    let text: string | undefined;
                    switch (queryType) {
                        case QueryType.OnScreen:
                            text = this.strings.get('Msg:SelAcrossScreen');
                            break;
                        case QueryType.OnMap:
                            text = this.strings.get('Msg:SelAcrossMap');
                            break;
                        case QueryType.Veteran:
                        case QueryType.Health: {
                            if (!selection.length &&
                                ((queryType === QueryType.Veteran && veteranLevel === undefined) ||
                                    (queryType === QueryType.Health && healthLevel === undefined))) {
                                text = this.strings.get('Msg:NavEmpty');
                                break;
                            }
                            let description: string | undefined;
                            if (queryType === QueryType.Veteran) {
                                switch (veteranLevel) {
                                    case VeteranLevel.Elite:
                                        description = this.strings.get('Msg:Elite');
                                        break;
                                    case VeteranLevel.Veteran:
                                        description = this.strings.get('Msg:Veteran');
                                        break;
                                    case VeteranLevel.None:
                                        description = this.strings.get('Msg:LittleExperience');
                                        break;
                                }
                            }
                            else {
                                switch (healthLevel) {
                                    case HealthLevel.Green:
                                        description = this.strings.get('Msg:Healthy');
                                        break;
                                    case HealthLevel.Yellow:
                                        description = this.strings.get('Msg:HeavilyDamaged');
                                        break;
                                    case HealthLevel.Red:
                                        description = this.strings.get('Msg:Critical');
                                        break;
                                }
                            }
                            if (description !== undefined) {
                                description = description.toUpperCase();
                                if (selection.length) {
                                    const totalCost = selection.reduce((sum: number, unit: any) => sum + unit.rules.cost, 0);
                                    text = this.strings.get('Msg:UnitsWorth', selection.length, description, totalCost);
                                }
                                else {
                                    text = this.strings.get('Msg:NoUnitsSel', description);
                                }
                            }
                            break;
                        }
                    }
                    if (text) {
                        this.messageList.addUiFeedbackMessage(text);
                    }
                }
                else {
                    this.messageList.addUiFeedbackMessage(this.strings.get('Msg:NothingSelected'));
                }
            }
            else if (canPlay) {
                const voice = selection.find((unit: any) => unit.rules.voiceSelect)?.rules.voiceSelect;
                if (voice) {
                    this.sound.play(voice, ChannelType.Effect);
                }
            }
        }
    }
}
