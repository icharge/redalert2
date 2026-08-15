System.register(
  "game/trigger/condition/BuildObjectTypeCondition",
  ["game/trigger/TriggerCondition", "game/event/EventType"],
  function (e, t) {
    "use strict";
    var i, r, s;
    t && t.id;
    return {
      setters: [
        function (e) {
          i = e;
        },
        function (e) {
          r = e;
        },
      ],
      execute: function () {
        ((s = class extends i.TriggerCondition {
          constructor(e, t, i) {
            (super(e, t),
              (this.objectType = i),
              (this.objectIndex = Number(e.params[1])));
          }
          check(e, t) {
            return t.some(
              (e) =>
                e.type === r.EventType.ObjectSpawn &&
                e.gameObject.type === this.objectType &&
                e.gameObject.rules.index === this.objectIndex,
            );
          }
        }),
          e("BuildObjectTypeCondition", s));
      },
    };
  },
);
