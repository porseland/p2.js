var GSSolver = require('../solver/GSSolver').GSSolver
,    NaiveBroadphase = require('../collision/NaiveBroadphase')
,    vec2 = require('../math/vec2')
,    Circle = require('../objects/Shape').Circle
,    Rectangle = require('../objects/Shape').Rectangle
,    Compound = require('../objects/Shape').Compound
,    Convex = require('../objects/Shape').Convex
,    Line = require('../objects/Shape').Line
,    Plane = require('../objects/Shape').Plane
,    Particle = require('../objects/Shape').Particle
,    EventEmitter = require('../events/EventEmitter').EventEmitter
,    Body = require('../objects/Body').Body
,    Spring = require('../objects/Spring').Spring
,    DistanceConstraint = require('../constraints/DistanceConstraint').DistanceConstraint
,    PointToPointConstraint = require('../constraints/PointToPointConstraint').PointToPointConstraint
,    pkg = require('../../package.json')
,    Broadphase = require('../collision/Broadphase')
,    Nearphase = require('../collision/Nearphase')

exports.World = World;

function now(){
    if(performance.now)
        return performance.now();
    else if(performance.webkitNow)
        return performance.webkitNow();
    else
        return new Date().getTime();
}

/**
 * The dynamics world, where all bodies and constraints lives.
 *
 * @class World
 * @constructor
 * @param {Object}          [options]
 * @param {Solver}          options.solver Defaults to GSSolver.
 * @param {Float32Array}    options.gravity Defaults to [0,-9.78]
 * @param {Broadphase}      options.broadphase Defaults to NaiveBroadphase
 * @extends {EventEmitter}
 */
function World(options){
    EventEmitter.apply(this);

    options = options || {};

    /**
     * All springs in the world.
     *
     * @property springs
     * @type {Array}
     */
    this.springs = [];

    /**
     * All bodies in the world.
     *
     * @property bodies
     * @type {Array}
     */
    this.bodies = [];

    /**
     * The solver used to satisfy constraints and contacts.
     *
     * @property solver
     * @type {Solver}
     */
    this.solver = options.solver || new GSSolver();

    /**
     * The nearphase to use to generate contacts.
     *
     * @property nearphase
     * @type {Nearphase}
     */
    this.nearphase = new Nearphase();

    /**
     * Gravity in the world. This is applied on all bodies in the beginning of each step().
     *
     * @property
     * @type {Float32Array}
     */
    this.gravity = options.gravity || vec2.fromValues(0, -9.78);

    /**
     * Whether to do timing measurements during the step() or not.
     *
     * @property doPofiling
     * @type {Boolean}
     */
    this.doProfiling = options.doProfiling || false;

    /**
     * How many millisecconds the last step() took. This is updated each step if .doProfiling is set to true.
     *
     * @property lastStepTime
     * @type {Number}
     */
    this.lastStepTime = 0.0;

    /**
     * The broadphase algorithm to use.
     *
     * @property broadphase
     * @type {Broadphase}
     */
    this.broadphase = options.broadphase || new NaiveBroadphase();

    /**
     * User-added constraints.
     *
     * @property constraints
     * @type {Array}
     */
    this.constraints = [];

    /**
     * Friction between all bodies. Should in the future be replaced by per-body material properties.
     * @property friction
     * @type {Number}
     */
    this.friction = 0.1;

    /**
     * For keeping track of what time step size we used last step
     * @property lastTimeStep
     * @type {Number}
     */
    this.lastTimeStep = 1/60;

    // Id counters
    this._constraintIdCounter = 0;
    this._bodyIdCounter = 0;

    // Event objects that are reused
    this.postStepEvent = {
        type : "postStep",
    };
    this.addBodyEvent = {
        type : "addBody",
        body : null
    };
    this.addSpringEvent = {
        type : "addSpring",
        body : null
    };
};
World.prototype = new Object(EventEmitter.prototype);

/**
 * Add a constraint to the simulation.
 *
 * @method addConstraint
 * @param {Constraint} c
 */
World.prototype.addConstraint = function(c){
    this.constraints.push(c);
    c.id = this._constraintIdCounter++;
};

/**
 * Removes a constraint
 *
 * @method removeConstraint
 * @param {Constraint} c
 */
World.prototype.removeConstraint = function(c){
    var idx = this.constraints.indexOf(c);
    if(idx!==-1){
        this.constraints.splice(idx,1);
    }
};

var step_r = vec2.create();
var step_runit = vec2.create();
var step_u = vec2.create();
var step_f = vec2.create();
var step_fhMinv = vec2.create();
var step_velodt = vec2.create();

var xi_world = vec2.fromValues(0,0),
    xj_world = vec2.fromValues(0,0),
    zero = vec2.fromValues(0,0);

/**
 * Step the physics world forward in time.
 *
 * @method step
 * @param {Number} dt The time step size to use.
 * @param {Function} callback Called when done.
 */
World.prototype.step = function(dt){
    var that = this,
        doProfiling = this.doProfiling,
        Nsprings = this.springs.length,
        springs = this.springs,
        bodies = this.bodies,
        g = this.gravity,
        solver = this.solver,
        Nbodies = this.bodies.length,
        broadphase = this.broadphase,
        np = this.nearphase,
        constraints = this.constraints,
        t0, t1;

    this.lastTimeStep = dt;

    if(doProfiling){
        t0 = now();
    }

    // add gravity to bodies
    for(var i=0; i!==Nbodies; i++){
        var fi = bodies[i].force;
        vec2.add(fi,fi,g);
    }

    // Add spring forces
    for(var i=0; i!==Nsprings; i++){
        var s = springs[i];
        s.applyForce();
    }

    // Broadphase
    var result = broadphase.getCollisionPairs(this);

    // Nearphase
    var glen = vec2.length(this.gravity);
    np.reset();
    for(var i=0, Nresults=result.length; i!==Nresults; i+=2){
        var bi = result[i],
            bj = result[i+1];

        var reducedMass = (bi.invMass + bj.invMass);
        if(reducedMass > 0)
            reducedMass = 1/reducedMass;

        var mu = this.friction; // Todo: Should be looked up in a material table
        var mug = mu * glen * reducedMass;
        var doFriction = mu>0;

        // Loop over all shapes of body i
        for(var k=0; k<bi.shapes.length; k++){
            var si = bi.shapes[k],
                xi = bi.shapeOffsets[k] || zero,
                ai = bi.shapeAngles[k] || 0;

            // All shapes of body j
            for(var l=0; l<bj.shapes.length; l++){
                var sj = bj.shapes[l],
                    xj = bj.shapeOffsets[l] || zero,
                    aj = bj.shapeAngles[l] || 0;

                vec2.rotate(xi_world, xi, bi.angle);
                vec2.rotate(xj_world, xj, bj.angle);
                vec2.add(xi_world, xi_world, bi.position);
                vec2.add(xj_world, xj_world, bj.position);
                var ai_world = ai + bi.angle;
                var aj_world = aj + bj.angle;

                // Try new nearphase
                np.enableFriction = mu > 0;
                np.slipForce = mug;
                if(si instanceof Circle){
                         if(sj instanceof Circle)   np.circleCircle  (bi,si,xi_world,ai_world, bj,sj,xj_world,aj_world);
                    else if(sj instanceof Particle) np.circleParticle(bi,si,xi_world,ai_world, bj,sj,xj_world,aj_world);
                    else if(sj instanceof Plane)    np.circlePlane   (bi,si,xi_world,ai_world, bj,sj,xj_world,aj_world);
                    else if(sj instanceof Rectangle)np.circleConvex  (bi,si,xi_world,ai_world, bj,sj,xj_world,aj_world);
                    else if(sj instanceof Convex)   np.circleConvex  (bi,si,xi_world,ai_world, bj,sj,xj_world,aj_world);
                    else if(sj instanceof Line)     np.circleLine    (bi,si,xi_world,ai_world, bj,sj,xj_world,aj_world);

                } else if(si instanceof Particle){
                         if(sj instanceof Circle)   np.circleParticle(bj,sj,xj_world,aj_world, bi,si,xi_world,ai_world);
                    else if(sj instanceof Plane)    np.particlePlane (bi,si,xi_world,ai_world, bj,sj,xj_world,aj_world);

                } else if(si instanceof Plane){
                         if(sj instanceof Circle)   np.circlePlane   (bj,sj,xj_world,aj_world, bi,si,xi_world,ai_world);
                    else if(sj instanceof Particle) np.particlePlane (bj,sj,xj_world,aj_world, bi,si,xi_world,ai_world);
                    else if(sj instanceof Rectangle)np.convexPlane   (bj,sj,xj_world,aj_world, bi,si,xi_world,ai_world);
                    else if(sj instanceof Convex)   np.convexPlane   (bj,sj,xj_world,aj_world, bi,si,xi_world,ai_world);
                    else if(sj instanceof Line)     np.planeLine     (bi,si,xi_world,ai_world, bj,sj,xj_world,aj_world);

                } else if(si instanceof Rectangle){
                         if(sj instanceof Plane)    np.convexPlane    (bi,si,xi_world,ai_world, bj,sj,xj_world,aj_world);
                    else if(sj instanceof Circle)   np.circleConvex   (bj,sj,xj_world,aj_world, bi,si,xi_world,ai_world);
                    else if(sj instanceof Rectangle)np.convexConvex   (bj,sj,xj_world,aj_world, bi,si,xi_world,ai_world);

                } else if(si instanceof Convex){
                         if(sj instanceof Plane)    np.convexPlane    (bi,si,xi_world,ai_world, bj,sj,xj_world,aj_world);
                    else if(sj instanceof Circle)   np.circleConvex   (bj,sj,xj_world,aj_world, bi,si,xi_world,ai_world);
                    else if(sj instanceof Convex)   np.convexConvex   (bj,sj,xj_world,aj_world, bi,si,xi_world,ai_world);

                } else if(si instanceof Line){
                         if(sj instanceof Circle)   np.circleLine     (bj,sj,xj_world,aj_world, bi,si,xi_world,ai_world);
                    else if(sj instanceof Plane)    np.planeLine      (bj,sj,xj_world,aj_world, bi,si,xi_world,ai_world);

                }
            }
        }
    }

    // Add contact equations to solver
    for(var i=0, Ncontacts=np.contactEquations.length; i!==Ncontacts; i++){
        solver.addEquation(np.contactEquations[i]);
    }
    for(var i=0, Nfriction=np.frictionEquations.length; i!==Nfriction; i++){
        solver.addEquation(np.frictionEquations[i]);
    }

    // Add user-defined constraint equations
    var Nconstraints = constraints.length;
    for(i=0; i!==Nconstraints; i++){
        var c = constraints[i];
        c.update();
        for(var j=0, Neq=c.equations.length; j!==Neq; j++){
            var eq = c.equations[j];
            solver.addEquation(eq);
        }
    }
    solver.solve(dt,this);

    solver.removeAllEquations();

    // Step forward
    var fhMinv = step_fhMinv;
    var velodt = step_velodt;

    for(var i=0; i!==Nbodies; i++){
        var body = bodies[i];

        if(body.mass>0){
            var minv = 1.0 / body.mass,
                f = body.force,
                pos = body.position,
                velo = body.velocity;

            // Angular step
            body.angularVelocity += body.angularForce * body.invInertia * dt;
            body.angle += body.angularVelocity * dt;

            // Linear step
            vec2.scale(fhMinv,f,dt*minv);
            vec2.add(velo,fhMinv,velo);
            vec2.scale(velodt,velo,dt);
            vec2.add(pos,pos,velodt);
        }
    }

    // Reset force
    for(var i=0; i!==Nbodies; i++){
        var bi = bodies[i];
        vec2.set(bi.force,0.0,0.0);
        bi.angularForce = 0.0;
    }

    if(doProfiling){
        t1 = now();
        that.lastStepTime = t1-t0;
    }

    this.emit(this.postStepEvent);
};

/**
 * Add a spring to the simulation
 *
 * @method addSpring
 * @param {Spring} s
 */
World.prototype.addSpring = function(s){
    this.springs.push(s);
    this.addSpringEvent.spring = s;
    this.emit(this.addSpringEvent);
};

/**
 * Remove a spring
 *
 * @method removeSpring
 * @param {Spring} s
 */
World.prototype.removeSpring = function(s){
    var idx = this.springs.indexOf(s);
    if(idx===-1)
        this.springs.splice(idx,1);
};

/**
 * Add a body to the simulation
 *
 * @method addBody
 * @param {Body} body
 */
World.prototype.addBody = function(body){
    this.bodies.push(body);
    this.addBodyEvent.body = body;
    this.emit(this.addBodyEvent);
};

/**
 * Remove a body from the simulation
 *
 * @method removeBody
 * @param {Body} body
 */
World.prototype.removeBody = function(body){
    var idx = this.bodies.indexOf(body);
    if(idx!==-1)
        this.bodies.splice(idx,1);
};

/**
 * Convert the world to a JSON-serializable Object.
 *
 * @method toJSON
 * @return {Object}
 */
World.prototype.toJSON = function(){
    var json = {
        p2 : pkg.version,
        bodies : [],
        springs : [],
        solver : {},
        gravity : v2a(this.gravity),
        broadphase : {},
        constraints : [],
    };

    // Serialize springs
    for(var i=0; i<this.springs.length; i++){
        var s = this.springs[i];
        json.springs.push({
            bodyA : this.bodies.indexOf(s.bodyA),
            bodyB : this.bodies.indexOf(s.bodyB),
            stiffness : s.stiffness,
            damping : s.damping,
            restLength : s.restLength,
        });
    }

    // Serialize constraints
    for(var i=0; i<this.constraints.length; i++){
        var c = this.constraints[i];
        var jc = {
            bodyA : this.bodies.indexOf(c.bodyA),
            bodyB : this.bodies.indexOf(c.bodyB),
        }
        if(c instanceof DistanceConstraint){
            jc.type = "DistanceConstraint";
            jc.distance = c.distance;
        } else if(c instanceof PointToPointConstraint){
            jc.type = "PointToPointConstraint";
            jc.pivotA = v2a(c.pivotA);
            jc.pivotB = v2a(c.pivotB);
            jc.maxForce = c.maxForce;
        } else
            throw new Error("Constraint not supported yet!");

        json.constraints.push(jc);
    }

    // Serialize bodies
    for(var i=0; i<this.bodies.length; i++){
        var b = this.bodies[i],
            ss = b.shapes,
            jsonShapes = [];

        for(var j=0; j<ss.length; j++){
            var s = ss[j],
                jsonShape;

            // Check type
            if(s instanceof Circle){
                jsonShape = {
                    type : "Circle",
                    radius : s.radius,
                };
            } else if(s instanceof Plane){
                jsonShape = { type : "Plane", };
            } else if(s instanceof Particle){
                jsonShape = { type : "Particle", };
            } else if(s instanceof Line){
                jsonShape = {   type : "Line",
                                length : s.length };
            } else if(s instanceof Rectangle){
                jsonShape = {   type : "Rectangle",
                                width : s.width,
                                height : s.height };
            } else if(s instanceof Convex){
                var verts = [];
                for(var k=0; k<s.vertices.length; k++)
                    verts.push(v2a(s.vertices[k]));
                jsonShape = {   type : "Convex",
                                verts : verts };
            } else {
                throw new Error("Shape type not supported yet!");
            }

            jsonShape.offset = v2a(b.shapeOffsets[j] || [0,0]);
            jsonShape.angle = b.shapeAngles[j] || 0;

            jsonShapes.push(jsonShape);
        }
        json.bodies.push({
            mass : b.mass,
            angle : b.angle,
            position : v2a(b.position),
            velocity : v2a(b.velocity),
            angularVelocity : b.angularVelocity,
            force : v2a(b.force),
            shapes : jsonShapes,
        });
    }
    return json;

    function v2a(v){
        return [v[0],v[1]];
    }
};

/**
 * Load a scene from a serialized state.
 *
 * @method fromJSON
 * @param  {Object} json
 * @return {Boolean} True on success, else false.
 */
World.prototype.fromJSON = function(json){
    this.clear();

    if(!json.p2)
        return false;

    switch(json.p2){

        case pkg.version:

            // Set gravity
            vec2.copy(world.gravity, json.gravity);

            // Load bodies
            for(var i=0; i<json.bodies.length; i++){
                var jb = json.bodies[i],
                    jss = jb.shapes;

                var b = new Body({
                    mass :              jb.mass,
                    position :          jb.position,
                    angle :             jb.angle,
                    velocity :          jb.velocity,
                    angularVelocity :   jb.angularVelocity,
                    force :             jb.force,
                });

                for(var j=0; j<jss.length; j++){
                    var shape, js=jss[j];

                    switch(js.type){
                        case "Circle":      shape = new Circle(js.radius);              break;
                        case "Plane":       shape = new Plane();                        break;
                        case "Particle":    shape = new Particle();                     break;
                        case "Line":        shape = new Line(js.length);                break;
                        case "Rectangle":   shape = new Rectangle(js.width,js.height);  break;
                        case "Convex":      shape = new Convex(js.verts);               break;
                        default:
                            throw new Error("Shape type not supported: "+js.type);
                            break;
                    }
                    b.addShape(shape,js.offset,js.angle);
                }

                this.addBody(b);
            }

            // Load springs
            for(var i=0; i<json.springs.length; i++){
                var js = json.springs[i];
                var s = new Spring(this.bodies[js.bodyA], this.bodies[js.bodyB], {
                    stiffness : js.stiffness,
                    damping : js.damping,
                    restLength : js.restLength,
                });
                this.addSpring(s);
            }

            // Load constraints
            for(var i=0; i<json.constraints.length; i++){
                var jc = json.constraints[i],
                    c;
                switch(jc.type){
                    case "DistanceConstraint":
                        c = new DistanceConstraint(this.bodies[jc.bodyA], this.bodies[jc.bodyB], jc.distance);
                        break;
                    case "PointToPointConstraint":
                        c = new PointToPointConstraint(this.bodies[jc.bodyA], jc.pivotA, this.bodies[jc.bodyB], jc.pivotB, jc.maxForce);
                        break;
                    default:
                        throw new Error("Constraint type not recognized: "+jc.type);
                }
                this.addConstraint(c);
            }

            break;

        default:
            return false;
            break;
    }

    return true;
};

/**
 * Resets the World, removes all bodies, constraints and springs.
 *
 * @method clear
 */
World.prototype.clear = function(){

    // Remove all constraints
    var cs = this.constraints;
    for(var i=cs.length-1; i>=0; i--){
        this.removeConstraint(cs[i]);
    }

    // Remove all bodies
    var bodies = this.bodies;
    for(var i=bodies.length-1; i>=0; i--){
        this.removeBody(bodies[i]);
    }

    // Remove all springs
    var springs = this.springs;
    for(var i=springs.length-1; i>=0; i--){
        this.removeSpring(springs[i]);
    }
};
