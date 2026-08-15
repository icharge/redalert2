System.register(
  "game/trigger/executor/ChangeHouseExecutor",
  ["game/gameobject/GameObject", "game/trigger/TriggerExecutor"],
  function (e, t) {
    "use strict";
    var s, i, n;
    t && t.id;
    return {
      setters: [
        function (e) {
          s = e;
        },
        function (e) {
          i = e;
        },
      ],
      execute: function () {
        ((n = class n extends i.TriggerExecutor {
          constructor(e, t) {
            (super(e, t), (this.houseId = Number(e.params[1])));
          }
          execute(e, t) {
            let i;
            if (
              this.houseId >= n.locationHouseIdBegin &&
              this.houseId <
                n.locationHouseIdBegin + e.map.startingLocations.length
            ) {
              let t = this.houseId - n.locationHouseIdBegin;
              i = e.getAllPlayers().find((e) => e.startLocation === t);
            } else
              i = e.getAllPlayers().find((e) => e.country?.id === this.houseId);
            if (
              (i?.defeated &&
                (i = e.isAssetRedistributionEnabled()
                  ? e.alliances.getAllies(i)[0]
                  : void 0),
              i)
            )
              for (var r of t)
                r instanceof s.GameObject &&
                  r.isSpawned &&
                  e.changeObjectOwner(r, i);
          }
        }),
          e("ChangeHouseExecutor", n),
          (n.locationHouseIdBegin = 4475));
      },
    };
  },
);
